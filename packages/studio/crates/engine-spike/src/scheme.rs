//! A tiny Scheme: a reader, a pass that resolves variables to frame slots or
//! globals, and an evaluator with proper tail calls in a loop (chapter 00
//! §1.1 rules out wasm tail calls). Enough for a score's `#(define …)`, a
//! music function's arithmetic and the speed benchmark of 09-spike.md; not
//! chapter 03's interpreter, which keeps its stacks and heap in arenas.

use crate::text::{push_int, push_num};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

#[derive(Clone)]
pub enum Value {
    Nil,
    Unspecified,
    Bool(bool),
    Int(i64),
    Real(f64),
    Str(Rc<str>),
    Sym(u32),
    Pair(Rc<(Value, Value)>),
    Closure(Rc<Closure>),
    Prim(u16),
}

pub struct Closure {
    proto: Rc<Proto>,
    env: Env,
}

struct Proto {
    params: usize,
    rest: bool,
    slots: usize,
    body: Node,
}

struct Frame {
    slots: RefCell<Vec<Value>>,
    parent: Env,
}

type Env = Option<Rc<Frame>>;
pub type R = Result<Value, String>;

enum Node {
    Const(Value),
    Local(u16, u16),
    Global(u32),
    SetLocal(u16, u16, Box<Node>),
    SetGlobal(u32, Box<Node>, bool),
    If(Box<(Node, Node, Node)>),
    Lambda(Rc<Proto>),
    Seq(Box<[Node]>),
    Call(Box<Node>, Box<[Node]>),
    And(Box<[Node]>),
    Or(Box<[Node]>),
}

/// What a node in tail position leaves: a value, or a call for the loop in `apply`.
enum Flow {
    Value(Value),
    Call(Value, Vec<Value>),
}

/// Non-tail calls nest Rust frames. Past this much stack a score gets an
/// error, not a trap: wasm's stack is Rust's 1 MiB, a test thread's 2 MiB.
const MAX_STACK: usize = 512 * 1024;

pub struct Interp {
    names: Vec<Box<str>>,
    ids: BTreeMap<Box<str>, u32>,
    globals: Vec<Option<Value>>,
    /// The stack's address where the top-level evaluation began.
    stack_base: usize,
    /// What `display` wrote: it goes to the compile's stderr.
    pub output: String,
    /// The global staff size, which `set-global-staff-size` changes and the layout reads.
    pub staff_size: f64,
}

type Prim = fn(&mut Interp, Vec<Value>) -> R;

const PRIMS: &[(&str, Prim)] = &[
    ("+", |_, a| {
        arith(a, 0, |x, y| x.checked_add(y), |x, y| x + y)
    }),
    ("*", |_, a| {
        arith(a, 1, |x, y| x.checked_mul(y), |x, y| x * y)
    }),
    ("-", |_, a| match a.len() {
        1 => combine(Value::Int(0), &a, |x, y| x.checked_sub(y), |x, y| x - y),
        _ => fold(a, |x, y| x.checked_sub(y), |x, y| x - y),
    }),
    ("/", |_, a| {
        let mut r = real(a.first().ok_or("/: no arguments")?)?;
        if a.len() == 1 {
            return Ok(Value::Real(1.0 / r));
        }
        for v in &a[1..] {
            r /= real(v)?;
        }
        Ok(if r == (r as i64) as f64 {
            Value::Int(r as i64)
        } else {
            Value::Real(r)
        })
    }),
    ("quotient", |_, a| int2(&a, |x, y| x.checked_div(y))),
    ("remainder", |_, a| int2(&a, |x, y| x.checked_rem(y))),
    ("modulo", |_, a| {
        int2(&a, |x, y| {
            x.checked_rem(y).map(|r| {
                if r != 0 && (r < 0) != (y < 0) {
                    r + y
                } else {
                    r
                }
            })
        })
    }),
    ("=", |_, a| compare(a, |x, y| x == y)),
    ("<", |_, a| compare(a, |x, y| x < y)),
    (">", |_, a| compare(a, |x, y| x > y)),
    ("<=", |_, a| compare(a, |x, y| x <= y)),
    (">=", |_, a| compare(a, |x, y| x >= y)),
    ("not", |_, a| {
        Ok(Value::Bool(matches!(arg(&a, 0)?, Value::Bool(false))))
    }),
    ("eq?", |_, a| Ok(Value::Bool(eqv(arg(&a, 0)?, arg(&a, 1)?)))),
    ("eqv?", |_, a| {
        Ok(Value::Bool(eqv(arg(&a, 0)?, arg(&a, 1)?)))
    }),
    ("equal?", |_, a| {
        Ok(Value::Bool(equal(arg(&a, 0)?, arg(&a, 1)?)))
    }),
    ("null?", |_, a| {
        Ok(Value::Bool(matches!(arg(&a, 0)?, Value::Nil)))
    }),
    ("pair?", |_, a| {
        Ok(Value::Bool(matches!(arg(&a, 0)?, Value::Pair(_))))
    }),
    ("number?", |_, a| {
        Ok(Value::Bool(matches!(
            arg(&a, 0)?,
            Value::Int(_) | Value::Real(_)
        )))
    }),
    ("string?", |_, a| {
        Ok(Value::Bool(matches!(arg(&a, 0)?, Value::Str(_))))
    }),
    ("symbol?", |_, a| {
        Ok(Value::Bool(matches!(arg(&a, 0)?, Value::Sym(_))))
    }),
    ("procedure?", |_, a| {
        Ok(Value::Bool(matches!(
            arg(&a, 0)?,
            Value::Closure(_) | Value::Prim(_)
        )))
    }),
    ("cons", |_, a| {
        Ok(cons(arg(&a, 0)?.clone(), arg(&a, 1)?.clone()))
    }),
    ("car", |_, a| Ok(pair(arg(&a, 0)?, "car")?.0.clone())),
    ("cdr", |_, a| Ok(pair(arg(&a, 0)?, "cdr")?.1.clone())),
    ("cadr", |_, a| {
        Ok(pair(&pair(arg(&a, 0)?, "cadr")?.1, "cadr")?.0.clone())
    }),
    ("list", |_, a| Ok(list(a))),
    ("length", |_, a| {
        Ok(Value::Int(items(arg(&a, 0)?)?.len() as i64))
    }),
    ("reverse", |_, a| {
        let mut v = items(arg(&a, 0)?)?;
        v.reverse();
        Ok(list(v))
    }),
    ("append", |_, a| {
        let mut out = Vec::new();
        for v in &a {
            out.extend(items(v)?);
        }
        Ok(list(out))
    }),
    ("list-ref", |_, a| {
        let v = items(arg(&a, 0)?)?;
        let i = int(arg(&a, 1)?)?;
        v.get(i as usize)
            .cloned()
            .ok_or_else(|| "list-ref: index out of range".into())
    }),
    ("assq", |_, a| {
        for entry in items(arg(&a, 1)?)? {
            if let Value::Pair(p) = &entry
                && eqv(&p.0, arg(&a, 0)?)
            {
                return Ok(entry.clone());
            }
        }
        Ok(Value::Bool(false))
    }),
    ("apply", |me, mut a| {
        let tail = a.pop().ok_or("apply: no arguments")?;
        let f = a.remove(0);
        a.extend(items(&tail)?);
        me.apply(f, a)
    }),
    ("map", |me, a| {
        let f = arg(&a, 0)?.clone();
        let lists = a[1..].iter().map(items).collect::<Result<Vec<_>, _>>()?;
        let n = lists.iter().map(Vec::len).min().unwrap_or(0);
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(me.apply(f.clone(), lists.iter().map(|l| l[i].clone()).collect())?);
        }
        Ok(list(out))
    }),
    ("for-each", |me, a| {
        let f = arg(&a, 0)?.clone();
        for v in items(arg(&a, 1)?)? {
            me.apply(f.clone(), vec![v])?;
        }
        Ok(Value::Unspecified)
    }),
    ("string-append", |_, a| {
        let mut s = String::new();
        for v in &a {
            s.push_str(string(v)?);
        }
        Ok(Value::Str(s.into()))
    }),
    ("string-length", |_, a| {
        Ok(Value::Int(string(arg(&a, 0)?)?.chars().count() as i64))
    }),
    ("number->string", |_, a| {
        let mut s = String::new();
        match arg(&a, 0)? {
            Value::Int(i) => push_int(&mut s, *i),
            v => push_num(&mut s, real(v)?),
        }
        Ok(Value::Str(s.into()))
    }),
    ("symbol->string", |me, a| match arg(&a, 0)? {
        Value::Sym(s) => Ok(Value::Str(me.names[*s as usize].as_ref().into())),
        _ => Err("symbol->string: not a symbol".into()),
    }),
    ("display", |me, a| {
        let mut s = core::mem::take(&mut me.output);
        me.write(&mut s, arg(&a, 0)?, false);
        me.output = s;
        Ok(Value::Unspecified)
    }),
    ("newline", |me, _| {
        me.output.push('\n');
        Ok(Value::Unspecified)
    }),
    ("set-global-staff-size", |me, a| {
        me.staff_size = real(arg(&a, 0)?)?;
        Ok(Value::Unspecified)
    }),
];

impl Default for Interp {
    fn default() -> Self {
        let mut me = Interp {
            names: Vec::new(),
            ids: BTreeMap::new(),
            globals: Vec::new(),
            stack_base: 0,
            output: String::new(),
            staff_size: 20.0,
        };
        for (i, (name, _)) in PRIMS.iter().enumerate() {
            let id = me.intern(name);
            me.globals[id as usize] = Some(Value::Prim(i as u16));
        }
        me
    }
}

impl Interp {
    pub fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(name.into());
        self.ids.insert(name.into(), id);
        self.globals.push(None);
        id
    }

    /// The globals, to restore before each compile: a score's Scheme does not outlive it (B5).
    pub fn snapshot(&self) -> (Vec<Option<Value>>, f64) {
        (self.globals.clone(), self.staff_size)
    }

    pub fn restore(&mut self, (globals, staff_size): &(Vec<Option<Value>>, f64)) {
        self.globals.truncate(globals.len());
        self.globals[..globals.len()].clone_from_slice(globals);
        // Symbols interned since stay interned, unbound.
        self.globals.resize(self.names.len(), None);
        self.staff_size = *staff_size;
        self.output.clear();
    }

    pub fn global(&self, name: &str) -> Option<&Value> {
        self.ids
            .get(name)
            .and_then(|&id| self.globals[id as usize].as_ref())
    }

    /// Reads one datum at `at`; returns it and where it ends.
    pub fn read(&mut self, src: &str, at: usize) -> Result<(Value, usize), String> {
        let b = src.as_bytes();
        let mut i = skip_space(b, at);
        let Some(&c) = b.get(i) else {
            return Err("unexpected end of Scheme input".into());
        };
        match c {
            b'(' | b'[' => {
                i += 1;
                let mut out = Vec::new();
                let mut tail = Value::Nil;
                loop {
                    i = skip_space(b, i);
                    match b.get(i) {
                        None => return Err("unterminated list".into()),
                        Some(b')' | b']') => return Ok((list_with(out, tail), i + 1)),
                        Some(b'.') if b.get(i + 1).is_some_and(|&c| delimiter(c)) => {
                            let (v, end) = self.read(src, i + 1)?;
                            tail = v;
                            i = skip_space(b, end);
                            if !matches!(b.get(i), Some(b')' | b']')) {
                                return Err("bad dotted list".into());
                            }
                        }
                        Some(_) => {
                            let (v, end) = self.read(src, i)?;
                            out.push(v);
                            i = end;
                        }
                    }
                }
            }
            b'\'' | b'`' => {
                let (v, end) = self.read(src, i + 1)?;
                let quote = Value::Sym(self.intern("quote"));
                Ok((list(vec![quote, v]), end))
            }
            b'"' => {
                let mut s = String::new();
                let mut chars = src[i + 1..].char_indices();
                while let Some((k, ch)) = chars.next() {
                    match ch {
                        '"' => return Ok((Value::Str(s.into()), i + 1 + k + 1)),
                        '\\' => match chars.next() {
                            Some((_, 'n')) => s.push('\n'),
                            Some((_, 't')) => s.push('\t'),
                            Some((_, other)) => s.push(other),
                            None => break,
                        },
                        _ => s.push(ch),
                    }
                }
                Err("unterminated string".into())
            }
            b')' | b']' => Err("unexpected ')'".into()),
            _ => {
                let end = (i..b.len()).find(|&k| delimiter(b[k])).unwrap_or(b.len());
                let token = &src[i..end];
                let value = match token {
                    "#t" | "#true" => Value::Bool(true),
                    "#f" | "#false" => Value::Bool(false),
                    _ => number(token).unwrap_or_else(|| Value::Sym(self.intern(token))),
                };
                Ok((value, end))
            }
        }
    }

    /// Evaluates a datum at top level.
    pub fn eval(&mut self, datum: &Value) -> R {
        let node = self.compile(datum, &mut Vec::new())?;
        self.stack_base = stack_address();
        self.run(&node, &None)
    }

    /// Reads and evaluates every datum of `src`.
    pub fn eval_all(&mut self, src: &str) -> R {
        let mut at = 0;
        let mut last = Value::Unspecified;
        while skip_space(src.as_bytes(), at) < src.len() {
            let (datum, end) = self.read(src, at)?;
            last = self.eval(&datum)?;
            at = end;
        }
        Ok(last)
    }

    fn compile(&mut self, x: &Value, scope: &mut Vec<Vec<u32>>) -> Result<Node, String> {
        match x {
            Value::Sym(s) => Ok(self.variable(*s, scope)),
            Value::Pair(p) => {
                if let Value::Sym(s) = p.0
                    && let Some(node) = self.special(s, &p.1, scope)?
                {
                    return Ok(node);
                }
                let f = self.compile(&p.0, scope)?;
                let args = items(&p.1)?
                    .iter()
                    .map(|a| self.compile(a, scope))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(Node::Call(Box::new(f), args.into()))
            }
            _ => Ok(Node::Const(x.clone())),
        }
    }

    fn variable(&self, s: u32, scope: &[Vec<u32>]) -> Node {
        for (depth, frame) in scope.iter().rev().enumerate() {
            if let Some(i) = frame.iter().rposition(|&v| v == s) {
                return Node::Local(depth as u16, i as u16);
            }
        }
        Node::Global(s)
    }

    fn special(
        &mut self,
        s: u32,
        rest: &Value,
        scope: &mut Vec<Vec<u32>>,
    ) -> Result<Option<Node>, String> {
        let args = items(rest)?;
        let node = match &*self.names[s as usize] {
            "quote" => Node::Const(arg(&args, 0)?.clone()),
            "if" => {
                let otherwise = match args.get(2) {
                    Some(e) => self.compile(e, scope)?,
                    None => Node::Const(Value::Unspecified),
                };
                Node::If(Box::new((
                    self.compile(arg(&args, 0)?, scope)?,
                    self.compile(arg(&args, 1)?, scope)?,
                    otherwise,
                )))
            }
            "define" => match arg(&args, 0)? {
                // (define (f . params) body…) is (define f (lambda params body…)).
                Value::Pair(p) => {
                    let Value::Sym(name) = p.0 else {
                        return Err("define: bad name".into());
                    };
                    let lambda = self.lambda(&p.1, &args[1..], scope)?;
                    self.assign(name, lambda, scope, true)
                }
                Value::Sym(name) => {
                    let value = match args.get(1) {
                        Some(e) => self.compile(e, scope)?,
                        None => Node::Const(Value::Unspecified),
                    };
                    self.assign(*name, value, scope, true)
                }
                _ => return Err("define: bad name".into()),
            },
            "set!" => {
                let Value::Sym(name) = arg(&args, 0)? else {
                    return Err("set!: not a variable".into());
                };
                let value = self.compile(arg(&args, 1)?, scope)?;
                self.assign(*name, value, scope, false)
            }
            "lambda" => self.lambda(arg(&args, 0)?, &args[1..], scope)?,
            "begin" => self.body(&args, scope)?,
            "let" => {
                // (let name ((v e)…) body…), named: a local procedure called at once.
                if let Value::Sym(name) = arg(&args, 0)? {
                    let bindings = items(arg(&args, 1)?)?;
                    let (vars, inits) = self.bindings(&bindings)?;
                    let lambda = list_with(
                        vec![self.sym("lambda"), list(vars)],
                        list(args[2..].to_vec()),
                    );
                    let define = list(vec![self.sym("define"), Value::Sym(*name), lambda]);
                    let call = list_with(vec![Value::Sym(*name)], list(inits));
                    let outer = list(vec![self.sym("lambda"), Value::Nil, define, call]);
                    return Ok(Some(self.compile(&list(vec![outer]), scope)?));
                }
                let bindings = items(arg(&args, 0)?)?;
                let (vars, inits) = self.bindings(&bindings)?;
                let lambda = list_with(
                    vec![self.sym("lambda"), list(vars)],
                    list(args[1..].to_vec()),
                );
                self.compile(&list_with(vec![lambda], list(inits)), scope)?
            }
            "let*" => {
                let bindings = items(arg(&args, 0)?)?;
                let body = list(args[1..].to_vec());
                let mut form = list_with(vec![self.sym("let"), Value::Nil], body);
                for b in bindings.into_iter().rev() {
                    form = list(vec![self.sym("let"), list(vec![b]), form]);
                }
                self.compile(&form, scope)?
            }
            "cond" => {
                let mut node = Node::Const(Value::Unspecified);
                for clause in args.iter().rev() {
                    let parts = items(clause)?;
                    let test = arg(&parts, 0)?;
                    let then = self.body(&parts[1..], scope)?;
                    node = match test {
                        Value::Sym(e) if &*self.names[*e as usize] == "else" => then,
                        _ => Node::If(Box::new((self.compile(test, scope)?, then, node))),
                    };
                }
                node
            }
            "when" | "unless" => {
                let test = self.compile(arg(&args, 0)?, scope)?;
                let then = self.body(&args[1..], scope)?;
                let none = Node::Const(Value::Unspecified);
                let when = &*self.names[s as usize] == "when";
                Node::If(Box::new(if when {
                    (test, then, none)
                } else {
                    (test, none, then)
                }))
            }
            "and" => Node::And(
                args.iter()
                    .map(|a| self.compile(a, scope))
                    .collect::<Result<Vec<_>, _>>()?
                    .into(),
            ),
            "or" => Node::Or(
                args.iter()
                    .map(|a| self.compile(a, scope))
                    .collect::<Result<Vec<_>, _>>()?
                    .into(),
            ),
            _ => return Ok(None),
        };
        Ok(Some(node))
    }

    fn sym(&mut self, name: &str) -> Value {
        Value::Sym(self.intern(name))
    }

    fn bindings(&self, bindings: &[Value]) -> Result<(Vec<Value>, Vec<Value>), String> {
        let mut vars = Vec::new();
        let mut inits = Vec::new();
        for b in bindings {
            let parts = items(b)?;
            vars.push(arg(&parts, 0)?.clone());
            inits.push(arg(&parts, 1)?.clone());
        }
        Ok((vars, inits))
    }

    fn assign(&mut self, name: u32, value: Node, scope: &[Vec<u32>], define: bool) -> Node {
        match self.variable(name, scope) {
            Node::Local(d, i) => Node::SetLocal(d, i, Box::new(value)),
            _ => Node::SetGlobal(name, Box::new(value), define),
        }
    }

    fn lambda(
        &mut self,
        params: &Value,
        body: &[Value],
        scope: &mut Vec<Vec<u32>>,
    ) -> Result<Node, String> {
        let mut frame = Vec::new();
        let mut p = params;
        while let Value::Pair(pair) = p {
            let Value::Sym(s) = pair.0 else {
                return Err("lambda: bad parameter".into());
            };
            frame.push(s);
            p = &pair.1;
        }
        let params = frame.len();
        let rest = if let Value::Sym(s) = p {
            frame.push(*s);
            true
        } else {
            false
        };
        // Internal defines become slots of this frame.
        for form in body {
            if let Value::Pair(f) = form
                && matches!(f.0, Value::Sym(d) if &*self.names[d as usize] == "define")
            {
                match items(&f.1)?.first() {
                    Some(Value::Sym(s)) => frame.push(*s),
                    Some(Value::Pair(p)) => {
                        if let Value::Sym(s) = p.0 {
                            frame.push(s)
                        }
                    }
                    _ => {}
                }
            }
        }
        scope.push(frame);
        let body = self.body(body, scope);
        let slots = scope.pop().map_or(0, |f| f.len());
        Ok(Node::Lambda(Rc::new(Proto {
            params,
            rest,
            slots,
            body: body?,
        })))
    }

    fn body(&mut self, forms: &[Value], scope: &mut Vec<Vec<u32>>) -> Result<Node, String> {
        let mut nodes = forms
            .iter()
            .map(|f| self.compile(f, scope))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(match nodes.len() {
            0 => Node::Const(Value::Unspecified),
            1 => nodes.pop().unwrap_or(Node::Const(Value::Unspecified)),
            _ => Node::Seq(nodes.into()),
        })
    }

    fn run(&mut self, node: &Node, env: &Env) -> R {
        match self.tail(node, env)? {
            Flow::Value(v) => Ok(v),
            Flow::Call(f, args) => self.apply(f, args),
        }
    }

    fn tail(&mut self, node: &Node, env: &Env) -> Result<Flow, String> {
        Ok(Flow::Value(match node {
            Node::Const(v) => v.clone(),
            Node::Local(d, i) => frame(env, *d).slots.borrow()[*i as usize].clone(),
            Node::Global(s) => match &self.globals[*s as usize] {
                Some(v) => v.clone(),
                None => {
                    let mut m = String::from("Unbound variable: ");
                    m.push_str(&self.names[*s as usize]);
                    return Err(m);
                }
            },
            Node::SetLocal(d, i, e) => {
                let v = self.run(e, env)?;
                frame(env, *d).slots.borrow_mut()[*i as usize] = v;
                Value::Unspecified
            }
            Node::SetGlobal(s, e, define) => {
                if !define && self.globals[*s as usize].is_none() {
                    let mut m = String::from("Unbound variable: ");
                    m.push_str(&self.names[*s as usize]);
                    return Err(m);
                }
                let v = self.run(e, env)?;
                self.globals[*s as usize] = Some(v);
                Value::Unspecified
            }
            Node::If(b) => {
                let test = self.run(&b.0, env)?;
                return self.tail(if truthy(&test) { &b.1 } else { &b.2 }, env);
            }
            Node::Lambda(p) => Value::Closure(Rc::new(Closure {
                proto: p.clone(),
                env: env.clone(),
            })),
            Node::Seq(nodes) => {
                let (last, init) = nodes.split_last().ok_or("empty body")?;
                for n in init {
                    self.run(n, env)?;
                }
                return self.tail(last, env);
            }
            Node::Call(f, args) => {
                let f = self.run(f, env)?;
                let args = args
                    .iter()
                    .map(|a| self.run(a, env))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Flow::Call(f, args));
            }
            Node::And(nodes) => {
                let Some((last, init)) = nodes.split_last() else {
                    return Ok(Flow::Value(Value::Bool(true)));
                };
                for n in init {
                    let v = self.run(n, env)?;
                    if !truthy(&v) {
                        return Ok(Flow::Value(v));
                    }
                }
                return self.tail(last, env);
            }
            Node::Or(nodes) => {
                let Some((last, init)) = nodes.split_last() else {
                    return Ok(Flow::Value(Value::Bool(false)));
                };
                for n in init {
                    let v = self.run(n, env)?;
                    if truthy(&v) {
                        return Ok(Flow::Value(v));
                    }
                }
                return self.tail(last, env);
            }
        }))
    }

    pub fn apply(&mut self, mut f: Value, mut args: Vec<Value>) -> R {
        if self.stack_base.saturating_sub(stack_address()) > MAX_STACK {
            return Err("Stack overflow".into());
        }
        loop {
            match f {
                Value::Prim(i) => break PRIMS[i as usize].1(self, args),
                Value::Closure(c) => {
                    let p = &c.proto;
                    if args.len() < p.params || (!p.rest && args.len() > p.params) {
                        break Err("Wrong number of arguments".into());
                    }
                    if p.rest {
                        let rest = args.split_off(p.params);
                        args.push(list(rest));
                    }
                    args.resize(p.slots, Value::Unspecified);
                    let env = Some(Rc::new(Frame {
                        slots: RefCell::new(args),
                        parent: c.env.clone(),
                    }));
                    match self.tail(&p.body, &env) {
                        Ok(Flow::Value(v)) => break Ok(v),
                        Ok(Flow::Call(next, next_args)) => {
                            f = next;
                            args = next_args;
                        }
                        Err(e) => break Err(e),
                    }
                }
                _ => break Err("Wrong type to apply".into()),
            }
        }
    }

    /// `display` (`write` with quotes when `quoted`).
    pub fn write(&self, out: &mut String, v: &Value, quoted: bool) {
        match v {
            Value::Nil => out.push_str("()"),
            Value::Unspecified => out.push_str("#<unspecified>"),
            Value::Bool(b) => out.push_str(if *b { "#t" } else { "#f" }),
            Value::Int(i) => push_int(out, *i),
            Value::Real(r) => push_num(out, *r),
            Value::Str(s) if quoted => {
                out.push('"');
                out.push_str(s);
                out.push('"');
            }
            Value::Str(s) => out.push_str(s),
            Value::Sym(s) => out.push_str(&self.names[*s as usize]),
            Value::Pair(_) => {
                out.push('(');
                let mut p = v;
                let mut first = true;
                while let Value::Pair(pair) = p {
                    if !first {
                        out.push(' ');
                    }
                    first = false;
                    self.write(out, &pair.0, quoted);
                    p = &pair.1;
                }
                if !matches!(p, Value::Nil) {
                    out.push_str(" . ");
                    self.write(out, p, quoted);
                }
                out.push(')');
            }
            Value::Closure(_) | Value::Prim(_) => out.push_str("#<procedure>"),
        }
    }
}

/// Where the stack is now; it grows downwards, natively and in wasm.
#[inline(never)]
fn stack_address() -> usize {
    let here = 0u8;
    core::hint::black_box(&here) as *const u8 as usize
}

fn frame(env: &Env, depth: u16) -> &Frame {
    let mut f = env.as_deref();
    for _ in 0..depth {
        f = f.and_then(|x| x.parent.as_deref());
    }
    // A Local node is only made inside the frames that resolve it.
    f.unwrap_or_else(|| unreachable!())
}

pub fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Bool(false))
}

pub fn cons(a: Value, b: Value) -> Value {
    Value::Pair(Rc::new((a, b)))
}

pub fn list(v: Vec<Value>) -> Value {
    list_with(v, Value::Nil)
}

fn list_with(v: Vec<Value>, tail: Value) -> Value {
    v.into_iter().rev().fold(tail, |acc, x| cons(x, acc))
}

fn items(v: &Value) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut p = v;
    while let Value::Pair(pair) = p {
        out.push(pair.0.clone());
        p = &pair.1;
    }
    match p {
        Value::Nil => Ok(out),
        _ => Err("Wrong type (expecting list)".into()),
    }
}

fn arg(a: &[Value], i: usize) -> Result<&Value, String> {
    a.get(i).ok_or_else(|| "Wrong number of arguments".into())
}

fn pair<'a>(v: &'a Value, who: &str) -> Result<&'a (Value, Value), String> {
    match v {
        Value::Pair(p) => Ok(p),
        _ => {
            let mut m = String::from(who);
            m.push_str(": wrong type (expecting pair)");
            Err(m)
        }
    }
}

fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Int(i) => Ok(*i),
        _ => Err("Wrong type (expecting exact integer)".into()),
    }
}

pub fn real(v: &Value) -> Result<f64, String> {
    match v {
        Value::Int(i) => Ok(*i as f64),
        Value::Real(r) => Ok(*r),
        _ => Err("Wrong type (expecting number)".into()),
    }
}

fn string(v: &Value) -> Result<&str, String> {
    match v {
        Value::Str(s) => Ok(s),
        _ => Err("Wrong type (expecting string)".into()),
    }
}

fn arith(a: Vec<Value>, unit: i64, i: fn(i64, i64) -> Option<i64>, r: fn(f64, f64) -> f64) -> R {
    combine(Value::Int(unit), &a, i, r)
}

fn fold(a: Vec<Value>, i: fn(i64, i64) -> Option<i64>, r: fn(f64, f64) -> f64) -> R {
    combine(arg(&a, 0)?.clone(), &a[1..], i, r)
}

fn combine(
    mut acc: Value,
    a: &[Value],
    i: fn(i64, i64) -> Option<i64>,
    r: fn(f64, f64) -> f64,
) -> R {
    for v in a {
        acc = match (&acc, v) {
            (Value::Int(x), Value::Int(y)) => match i(*x, *y) {
                Some(n) => Value::Int(n),
                None => Value::Real(r(*x as f64, *y as f64)),
            },
            _ => Value::Real(r(real(&acc)?, real(v)?)),
        };
    }
    Ok(acc)
}

fn int2(a: &[Value], f: fn(i64, i64) -> Option<i64>) -> R {
    f(int(arg(a, 0)?)?, int(arg(a, 1)?)?)
        .map(Value::Int)
        .ok_or_else(|| "Numerical overflow or division by zero".into())
}

fn compare(a: Vec<Value>, f: fn(f64, f64) -> bool) -> R {
    for w in a.windows(2) {
        if !f(real(&w[0])?, real(&w[1])?) {
            return Ok(Value::Bool(false));
        }
    }
    Ok(Value::Bool(true))
}

fn eqv(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Nil, Value::Nil) | (Value::Unspecified, Value::Unspecified) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Int(x), Value::Int(y)) => x == y,
        (Value::Real(x), Value::Real(y)) => x == y,
        (Value::Sym(x), Value::Sym(y)) => x == y,
        (Value::Prim(x), Value::Prim(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => Rc::ptr_eq(x, y),
        (Value::Pair(x), Value::Pair(y)) => Rc::ptr_eq(x, y),
        (Value::Closure(x), Value::Closure(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Pair(x), Value::Pair(y)) => equal(&x.0, &y.0) && equal(&x.1, &y.1),
        _ => eqv(a, b),
    }
}

fn delimiter(c: u8) -> bool {
    c.is_ascii_whitespace() || matches!(c, b'(' | b')' | b'[' | b']' | b'"' | b';')
}

fn skip_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
        } else if b[i] == b';' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else {
            break;
        }
    }
    i
}

/// An integer or a decimal fraction; not `str::parse::<f64>`, whose code is
/// several KB of wasm (09-spike.md §2).
fn number(t: &str) -> Option<Value> {
    let (neg, digits) = match t.as_bytes().first()? {
        b'-' | b'+' if t.len() > 1 => (t.starts_with('-'), &t[1..]),
        _ => (false, t),
    };
    let (whole, frac) = match digits.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (digits, None),
    };
    if whole.is_empty() && frac.is_none_or(str::is_empty) {
        return None;
    }
    if !whole
        .bytes()
        .chain(frac.unwrap_or("").bytes())
        .all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let mut n: i64 = 0;
    for c in whole.bytes() {
        n = n.checked_mul(10)?.checked_add((c - b'0') as i64)?;
    }
    let sign = if neg { -1 } else { 1 };
    match frac {
        None => Some(Value::Int(sign * n)),
        Some(f) => {
            let mut r = n as f64;
            let mut scale = 0.1;
            for c in f.bytes() {
                r += (c - b'0') as f64 * scale;
                scale /= 10.0;
            }
            Some(Value::Real(sign as f64 * r))
        }
    }
}
