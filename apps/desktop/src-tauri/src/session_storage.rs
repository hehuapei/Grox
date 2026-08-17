//! 会话本地数据的并发与删除门禁。
//!
//! 同一会话的 journal、媒体和队列操作互斥；不同会话可以并行。删除先写入
//! tombstone，再等待该会话现有写租约结束，因此晚到写入不能让已删除数据复活。

use std::{
    collections::BTreeSet,
    sync::{Condvar, Mutex},
};

#[derive(Default)]
struct SessionStorageInner {
    deleted: BTreeSet<String>,
    writing: BTreeSet<String>,
    deleting: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct SessionStorageState {
    inner: Mutex<SessionStorageInner>,
    changed: Condvar,
}

pub(crate) struct SessionWriteLease<'a> {
    storage: &'a SessionStorageState,
    ids: Vec<String>,
}

pub(crate) struct SessionDeleteLease<'a> {
    storage: &'a SessionStorageState,
    ids: Vec<String>,
}

impl SessionStorageState {
    pub(crate) fn begin_write(&self, id: &str) -> Result<SessionWriteLease<'_>, String> {
        self.begin_write_ids(&[id.to_string()])
    }

    pub(crate) fn begin_write_ids(&self, ids: &[String]) -> Result<SessionWriteLease<'_>, String> {
        let ids = unique_ids(ids)?;
        let mut inner = self.lock_inner()?;
        loop {
            if let Some(id) = ids.iter().find(|id| inner.deleted.contains(*id)) {
                return Err(format!("会话 {id} 已删除，拒绝再次写入本地存储"));
            }
            if ids
                .iter()
                .all(|id| !inner.writing.contains(id) && !inner.deleting.contains(id))
            {
                inner.writing.extend(ids.iter().cloned());
                return Ok(SessionWriteLease { storage: self, ids });
            }
            inner = self
                .changed
                .wait(inner)
                .map_err(|_| "会话存储门禁已损坏".to_string())?;
        }
    }

    pub(crate) fn begin_delete(&self, id: &str) -> Result<SessionDeleteLease<'_>, String> {
        self.begin_delete_ids(&[id.to_string()])
    }

    pub(crate) fn begin_delete_ids(
        &self,
        ids: &[String],
    ) -> Result<SessionDeleteLease<'_>, String> {
        let ids = unique_ids(ids)?;
        let mut inner = self.lock_inner()?;
        // 先标 tombstone，阻止等待期间出现新 writer。
        inner.deleted.extend(ids.iter().cloned());
        loop {
            if ids
                .iter()
                .all(|id| !inner.writing.contains(id) && !inner.deleting.contains(id))
            {
                inner.deleting.extend(ids.iter().cloned());
                return Ok(SessionDeleteLease { storage: self, ids });
            }
            inner = self
                .changed
                .wait(inner)
                .map_err(|_| "会话存储门禁已损坏".to_string())?;
        }
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, SessionStorageInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "会话存储门禁已损坏".to_string())
    }
}

impl Drop for SessionWriteLease<'_> {
    fn drop(&mut self) {
        let Ok(mut inner) = self.storage.inner.lock() else {
            return;
        };
        for id in &self.ids {
            inner.writing.remove(id);
        }
        self.storage.changed.notify_all();
    }
}

impl Drop for SessionDeleteLease<'_> {
    fn drop(&mut self) {
        let Ok(mut inner) = self.storage.inner.lock() else {
            return;
        };
        for id in &self.ids {
            inner.deleting.remove(id);
        }
        self.storage.changed.notify_all();
    }
}

fn unique_ids(ids: &[String]) -> Result<Vec<String>, String> {
    if ids.iter().any(String::is_empty) {
        return Err("会话存储操作包含空会话 ID".into());
    }
    Ok(ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

    use super::*;

    #[test]
    fn different_sessions_can_write_concurrently() {
        let storage = SessionStorageState::default();
        let _first = storage.begin_write("session-a").unwrap();
        let _second = storage.begin_write("session-b").unwrap();
    }

    #[test]
    fn same_session_writer_waits_for_existing_lease() {
        let storage = Arc::new(SessionStorageState::default());
        let first = storage.begin_write("session-a").unwrap();
        let (sent, received) = mpsc::channel();
        let waiting = Arc::clone(&storage);
        let thread = thread::spawn(move || {
            let _second = waiting.begin_write("session-a").unwrap();
            sent.send(()).unwrap();
        });

        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        thread.join().unwrap();
    }

    #[test]
    fn delete_waits_for_writer_then_rejects_late_write() {
        let storage = Arc::new(SessionStorageState::default());
        let writer = storage.begin_write("session-a").unwrap();
        let (sent, received) = mpsc::channel();
        let deleting = Arc::clone(&storage);
        let thread = thread::spawn(move || {
            let _delete = deleting.begin_delete("session-a").unwrap();
            sent.send(()).unwrap();
        });

        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(writer);
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        thread.join().unwrap();
        assert!(storage.begin_write("session-a").is_err());
    }
}
