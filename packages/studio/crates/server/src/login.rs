//! The sign-in page (DECISIONS D55): a form that posts to /login, and to
//! /signup when the server lets people create accounts. No script: it works
//! under a policy that allows none.

/// Which form a message belongs to.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Form {
    SignIn,
    SignUp,
}

pub struct LoginPage<'a> {
    pub message: Option<&'a str>,
    /// The form the message is about; sign-up opens with it.
    pub form: Form,
    pub signup: bool,
    /// The name typed, kept after a mistake.
    pub name: &'a str,
}

pub fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

const STYLE: &str = r#"
:root { --bg: #f5f5f4; --card: #fff; --fg: #1f1f1f; --muted: #6b6b6b; --border: #e2e2e0; --accent: #2f6fb0; --error: #b42318; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --card: #252526; --fg: #d4d4d4; --muted: #8c8c8c; --border: #333; --accent: #4d9be6; --error: #f97066; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; padding: 16px; }
main { width: min(360px, 100%); }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
.intro { color: var(--muted); margin: 0 0 20px; }
form { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; display: grid; gap: 12px; }
h2 { font-size: 15px; margin: 0; }
label { display: grid; gap: 4px; font-size: 13px; }
input { font: inherit; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { font: inherit; font-weight: 600; padding: 8px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
.message { color: var(--error); margin: 0; }
details { margin-top: 16px; }
summary { cursor: pointer; color: var(--accent); margin-bottom: 12px; }
"#;

pub fn render(page: &LoginPage) -> String {
    let message = |form: Form| match page.message {
        Some(message) if page.form == form => {
            format!(r#"<p class="message" role="alert">{}</p>"#, escape(message))
        }
        _ => String::new(),
    };
    let name = escape(page.name);
    let signup = if page.signup {
        format!(
            r#"<details{open}>
  <summary>New here? Create an account</summary>
  <form method="post" action="/signup">
    <h2>Create an account</h2>
    {message}
    <label>Name <input name="name" autocomplete="username" required minlength="2" maxlength="32" pattern="[a-z0-9][a-z0-9._\-]+" title="Lower-case letters, digits, dots, dashes and underscores" value="{name}"></label>
    <label>Password <input name="password" type="password" autocomplete="new-password" required minlength="{min}"></label>
    <label>Password again <input name="again" type="password" autocomplete="new-password" required minlength="{min}"></label>
    <button type="submit">Create Account</button>
  </form>
</details>"#,
            open = if page.form == Form::SignUp {
                " open"
            } else {
                ""
            },
            message = message(Form::SignUp),
            min = crate::users::MIN_PASSWORD,
        )
    } else {
        String::new()
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign In — Lily Studio</title>
<style>{STYLE}</style>
</head>
<body>
<main>
  <h1>Lily Studio</h1>
  <p class="intro">Write music as text, see it engraved, and hear it play.</p>
  <form method="post" action="/login">
    <h2>Sign in</h2>
    {message}
    <label>Name <input name="name" autocomplete="username" required autofocus value="{name}"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign In</button>
  </form>
  {signup}
</main>
</body>
</html>
"#,
        message = message(Form::SignIn),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_it_shows_and_offers_sign_up_only_when_allowed() {
        let page = render(&LoginPage {
            message: Some("<b>no</b>"),
            form: Form::SignIn,
            signup: false,
            name: "\"><script>",
        });
        assert!(page.contains("&lt;b&gt;no&lt;/b&gt;"));
        assert!(page.contains("&quot;&gt;&lt;script&gt;"));
        assert!(!page.contains("<script"));
        assert!(!page.contains("/signup"));
        let open = render(&LoginPage {
            message: Some("taken"),
            form: Form::SignUp,
            signup: true,
            name: "",
        });
        assert!(open.contains(r#"<details open>"#) && open.contains("/signup"));
    }
}
