use std::{
    process::Child,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
    },
};

#[derive(Clone, Default)]
pub(crate) struct JobControl {
    pub(crate) child: Arc<Mutex<Option<Child>>>,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) running: Arc<AtomicBool>,
}
