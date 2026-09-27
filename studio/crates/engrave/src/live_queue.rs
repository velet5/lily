//! One running request and one replaceable pending request per root
//! (DECISIONS D25), from src/preview/liveQueue.ts. Completion includes
//! consuming the result, so its files stay alive until the caller has read
//! them. Repeated edits never kill a nearly finished compilation.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::sync::oneshot;

type Job<T, E> = Box<dyn FnOnce() -> BoxFuture<'static, Result<T, E>> + Send>;
type Waiter<T, E> = oneshot::Sender<Result<Option<T>, E>>;

struct Slot<T, E> {
    next: Option<Job<T, E>>,
    waiting: Vec<Waiter<T, E>>,
}

/// Clones share the slots.
pub struct LiveQueue<K, T, E> {
    slots: Arc<Mutex<HashMap<K, Slot<T, E>>>>,
}

impl<K, T, E> Clone for LiveQueue<K, T, E> {
    fn clone(&self) -> Self {
        Self {
            slots: self.slots.clone(),
        }
    }
}

impl<K, T, E> Default for LiveQueue<K, T, E> {
    fn default() -> Self {
        Self {
            slots: Arc::default(),
        }
    }
}

impl<K, T, E> LiveQueue<K, T, E>
where
    K: Hash + Eq + Clone + Send + 'static,
    T: Clone + Send + 'static,
    E: Clone + Send + 'static,
{
    pub fn new() -> Self {
        Self::default()
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<K, Slot<T, E>>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `run` once the running request of `root` has finished, unless a
    /// newer request replaces it first; then it resolves with the newer one's
    /// result. `Ok(None)` when cancelled. Queued at the call; must be called
    /// within a Tokio runtime.
    pub fn request<F, Fut>(
        &self,
        root: K,
        run: F,
    ) -> impl Future<Output = Result<Option<T>, E>> + Send + 'static
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, E>> + Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        let job: Job<T, E> = Box::new(move || run().boxed());
        let mut slots = self.slots();
        match slots.get_mut(&root) {
            Some(slot) => {
                slot.next = Some(job);
                slot.waiting.push(sender);
            }
            None => {
                slots.insert(
                    root.clone(),
                    Slot {
                        next: Some(job),
                        waiting: vec![sender],
                    },
                );
                tokio::spawn(self.clone().drain(root));
            }
        }
        async move { receiver.await.unwrap_or(Ok(None)) }
    }

    /// Drops the waiting request of `root`; its callers get `Ok(None)`. The
    /// running one finishes: reopening the same preview must still wait for
    /// its old cancelled run to settle.
    pub fn cancel(&self, root: &K) {
        let mut slots = self.slots();
        let Some(slot) = slots.get_mut(root) else {
            return;
        };
        slot.next = None;
        for waiter in slot.waiting.drain(..) {
            let _ = waiter.send(Ok(None));
        }
    }

    async fn drain(self, root: K) {
        loop {
            let (job, waiting) = {
                let mut slots = self.slots();
                let Some(slot) = slots.get_mut(&root) else {
                    return;
                };
                match slot.next.take() {
                    Some(job) => (job, std::mem::take(&mut slot.waiting)),
                    None => {
                        slots.remove(&root);
                        return;
                    }
                }
            };
            let result = job().await;
            for waiter in waiting {
                let _ = waiter.send(result.clone().map(Some));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    async fn turn() {
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn continuous_requests_finish_the_running_revision_then_only_the_newest() {
        let queue: LiveQueue<&str, i32, String> = LiveQueue::new();
        let ran = Arc::new(StdMutex::new(Vec::new()));
        let (complete, completed) = oneshot::channel::<i32>();
        let r = ran.clone();
        let first = tokio::spawn(queue.request("root", move || async move {
            r.lock().unwrap().push(1);
            Ok(completed.await.unwrap_or(0))
        }));
        turn().await;
        let r = ran.clone();
        let second = tokio::spawn(queue.request("root", move || async move {
            r.lock().unwrap().push(2);
            Ok(2)
        }));
        let r = ran.clone();
        let third = tokio::spawn(queue.request("root", move || async move {
            r.lock().unwrap().push(3);
            Ok(3)
        }));
        turn().await;
        assert_eq!(
            *ran.lock().unwrap(),
            vec![1],
            "running work must not be cancelled"
        );
        complete.send(1).unwrap();
        let results = (
            first.await.unwrap(),
            second.await.unwrap(),
            third.await.unwrap(),
        );
        assert_eq!(results, (Ok(Some(1)), Ok(Some(3)), Ok(Some(3))));
        assert_eq!(*ran.lock().unwrap(), vec![1, 3]);
    }

    #[tokio::test]
    async fn closing_cancels_pending_work_and_a_rejected_run_does_not_wedge_the_queue() {
        let queue: LiveQueue<&str, i32, String> = LiveQueue::new();
        let (complete, completed) = oneshot::channel::<i32>();
        let first = queue.request(
            "root",
            move || async move { Ok(completed.await.unwrap_or(0)) },
        );
        turn().await;
        let pending = queue.request("root", || async { Ok(2) });
        queue.cancel(&"root");
        assert_eq!(pending.await, Ok(None));
        complete.send(1).unwrap();
        assert_eq!(first.await, Ok(Some(1)));
        assert_eq!(
            queue
                .request("root", || async { Err("failed".to_owned()) })
                .await,
            Err("failed".to_owned())
        );
        assert_eq!(queue.request("root", || async { Ok(3) }).await, Ok(Some(3)));
    }
}
