//! Windows Job Object helper for ACP child process trees.
//!
//! Evidence: `terminate_process` used only `child.kill()`; grandchildren
//! (cargo test, nested shells, tool spawns) could orphan after cancel.
//! Assign the agent child to a job with KILL_ON_JOB_CLOSE so the whole tree
//! dies when the job is terminated or the handle closes.

#![cfg(windows)]

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE, PROCESS_SET_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Owns a Job Object handle. Drop / terminate kills all processes in the job.
pub struct ProcessJob {
    handle: HANDLE,
}

// SAFETY: HANDLE is a kernel object we exclusively own for this job.
unsafe impl Send for ProcessJob {}

impl ProcessJob {
    /// Create a job that kills all members when the last handle closes.
    pub fn create_kill_on_close() -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|e| {
                let _ = CloseHandle(handle);
                format!("SetInformationJobObject failed: {e}")
            })?;
            Ok(Self { handle })
        }
    }

    /// Assign a running process (by PID) into this job.
    pub fn assign_pid(&self, pid: u32) -> Result<(), String> {
        if pid == 0 {
            return Err("invalid pid 0".into());
        }
        unsafe {
            let access =
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION;
            let process = OpenProcess(access, false, pid)
                .map_err(|e| format!("OpenProcess({pid}) failed: {e}"))?;
            let result = AssignProcessToJobObject(self.handle, process);
            let _ = CloseHandle(process);
            result.map_err(|e| format!("AssignProcessToJobObject({pid}) failed: {e}"))?;
            Ok(())
        }
    }

    /// Force-kill every process currently in the job (including grandchildren).
    pub fn terminate_tree(&self) {
        unsafe {
            let _ = TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE: closing the last handle terminates remaining members.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
