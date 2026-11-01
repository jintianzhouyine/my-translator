use super::*;
use std::cell::RefCell;

struct Fake {
    devices: RefCell<Vec<Device>>,
    defaults: RefCell<Vec<DefaultDevice>>,
    writes: RefCell<Vec<(String, String)>>,
    fail: RefCell<Option<(String, String)>>,
    uncertain_failure: RefCell<bool>,
}
impl Fake {
    fn new() -> Self {
        Self {
            devices: RefCell::new(vec![
                Device {
                    id: "mic-id".into(),
                    name: "Microphone".into(),
                    input: true,
                    output: false,
                    virtual_device: false,
                },
                Device {
                    id: "speaker-id".into(),
                    name: "Headphones".into(),
                    input: false,
                    output: true,
                    virtual_device: false,
                },
                Device {
                    id: "cable-id".into(),
                    name: "BlackHole 2ch".into(),
                    input: true,
                    output: true,
                    virtual_device: true,
                },
            ]),
            defaults: RefCell::new(vec![
                DefaultDevice {
                    key: "input".into(),
                    id: "mic-id".into(),
                },
                DefaultDevice {
                    key: "output".into(),
                    id: "speaker-id".into(),
                },
                DefaultDevice {
                    key: "system-output".into(),
                    id: "speaker-id".into(),
                },
            ]),
            writes: RefCell::new(vec![]),
            fail: RefCell::new(None),
            uncertain_failure: RefCell::new(false),
        }
    }
}
impl Backend for Fake {
    fn devices(&self) -> Result<Vec<Device>, String> {
        Ok(self.devices.borrow().clone())
    }
    fn defaults(&self) -> Result<Vec<DefaultDevice>, String> {
        Ok(self.defaults.borrow().clone())
    }
    fn set_default(&self, key: &str, id: &str) -> Result<(), DeviceChangeError> {
        if self
            .fail
            .borrow()
            .as_ref()
            .is_some_and(|x| x.0 == key && x.1 == id)
        {
            return Err(if *self.uncertain_failure.borrow() {
                DeviceChangeError::Unconfirmed("injected asynchronous timeout".into())
            } else {
                "injected failure".into()
            });
        }
        self.writes.borrow_mut().push((key.into(), id.into()));
        self.defaults
            .borrow_mut()
            .iter_mut()
            .find(|d| d.key == key)
            .unwrap()
            .id = id.into();
        Ok(())
    }
    fn paired_input<'a>(
        &self,
        output: &Device,
        devices: &'a [Device],
    ) -> Result<&'a Device, String> {
        devices
            .iter()
            .find(|d| d.id == output.id && d.input && d.virtual_device)
            .ok_or("no matching virtual input".into())
    }
}
struct Fixture {
    state: SystemAudioRouteState,
    backend: Fake,
}
impl Fixture {
    fn new() -> Self {
        Self {
            state: SystemAudioRouteState::new(
                std::env::temp_dir().join(format!("audio-defaults-test-{}", uuid::Uuid::new_v4())),
            ),
            backend: Fake::new(),
        }
    }
    fn begin(&self) -> AudioRoute {
        self.state
            .begin_with(&self.backend, "", "", "BlackHole 2ch")
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.state.path.parent().unwrap());
    }
}

#[test]
fn lease_changes_only_input_then_restores_and_repeated_stop_is_harmless() {
    let f = Fixture::new();
    let route = f.begin();
    assert_eq!(route.microphone_device, "Microphone");
    assert_eq!(route.system_device, "Headphones");
    assert_eq!(
        *f.backend.writes.borrow(),
        [("input".into(), "cable-id".into())]
    );
    assert!(f.state.path.exists());
    f.state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap();
    f.state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap();
    assert!(!f.state.path.exists());
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
}

#[test]
fn crash_recovery_uses_stable_ids_from_disk() {
    let f = Fixture::new();
    f.begin();
    let restarted = SystemAudioRouteState::new(f.state.path.parent().unwrap().to_path_buf());
    restarted.restore_with(&f.backend, None).unwrap();
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
}

#[test]
fn stale_stop_cannot_restore_another_call() {
    let f = Fixture::new();
    let first = f.begin();
    f.state
        .restore_with(&f.backend, Some(&first.route_id))
        .unwrap();
    let second = f.begin();
    f.state
        .restore_with(&f.backend, Some(&first.route_id))
        .unwrap();
    assert_eq!(f.backend.defaults.borrow()[0].id, "cable-id");
    assert_eq!(f.state.read().unwrap().unwrap().route_id, second.route_id);
}

#[test]
fn manually_selected_cable_requires_explicit_physical_recovery_devices() {
    let f = Fixture::new();
    for d in f.backend.defaults.borrow_mut().iter_mut() {
        d.id = "cable-id".into();
    }
    assert!(f
        .state
        .begin_with(&f.backend, "", "", "BlackHole 2ch")
        .is_err());
    assert!(f.backend.writes.borrow().is_empty());
    assert!(!f.state.path.exists());
    let route = f
        .state
        .begin_with(&f.backend, "Microphone", "Headphones", "BlackHole 2ch")
        .unwrap();
    assert_eq!(f.backend.defaults.borrow()[1].id, "speaker-id");
    f.state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap();
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
    assert_eq!(f.backend.defaults.borrow()[2].id, "speaker-id");
}

#[test]
fn switch_failure_rolls_back_roles_already_changed() {
    let f = Fixture::new();
    f.backend.defaults.borrow_mut().insert(
        1,
        DefaultDevice {
            key: "input-communications".into(),
            id: "mic-id".into(),
        },
    );
    *f.backend.fail.borrow_mut() = Some(("input-communications".into(), "cable-id".into()));
    assert!(f
        .state
        .begin_with(&f.backend, "", "", "BlackHole 2ch")
        .unwrap_err()
        .contains("已恢复"));
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
    assert!(!f.state.path.exists());
}

#[test]
fn unplugged_original_device_is_not_replaced_with_an_arbitrary_device() {
    let f = Fixture::new();
    let route = f.begin();
    f.backend.devices.borrow_mut().retain(|d| d.id != "mic-id");
    assert!(f
        .state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap_err()
        .contains("已断开"));
    assert_eq!(f.backend.defaults.borrow()[0].id, "cable-id");
    assert!(f.state.path.exists());
}

#[test]
fn failure_restoring_output_does_not_prevent_input_restoration_and_keeps_journal() {
    let f = Fixture::new();
    let route = f.begin();
    f.backend.defaults.borrow_mut()[1].id = "cable-id".into();
    *f.backend.fail.borrow_mut() = Some(("output".into(), "speaker-id".into()));
    assert!(f
        .state
        .restore_with(&f.backend, Some(&route.route_id))
        .is_err());
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
    assert!(f.state.path.exists());
    *f.backend.fail.borrow_mut() = None;
    f.state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap();
    assert!(!f.state.path.exists());
}

#[test]
fn duplicate_device_names_are_rejected_before_switching() {
    let f = Fixture::new();
    let mut other = f.backend.devices.borrow()[0].clone();
    other.id = "other".into();
    f.backend.devices.borrow_mut().push(other);
    assert!(f
        .state
        .begin_with(&f.backend, "Microphone", "", "BlackHole 2ch")
        .is_err());
    assert!(f.backend.writes.borrow().is_empty());
}

#[test]
fn manual_physical_replacement_unblocks_recovery_without_overwriting_it() {
    let f = Fixture::new();
    let route = f.begin();
    f.backend.devices.borrow_mut().retain(|d| d.id != "mic-id");
    f.backend.devices.borrow_mut().push(Device {
        id: "replacement".into(),
        name: "USB microphone".into(),
        input: true,
        output: false,
        virtual_device: false,
    });
    f.backend.defaults.borrow_mut()[0].id = "replacement".into();
    f.state
        .restore_with(&f.backend, Some(&route.route_id))
        .unwrap();
    assert_eq!(f.backend.defaults.borrow()[0].id, "replacement");
    assert!(!f.state.path.exists());
    assert_eq!(f.begin().microphone_device, "USB microphone");
}

#[test]
fn timed_out_switch_forces_rollback_even_if_current_still_matches_and_keeps_recovery() {
    let f = Fixture::new();
    *f.backend.fail.borrow_mut() = Some(("input".into(), "cable-id".into()));
    *f.backend.uncertain_failure.borrow_mut() = true;
    assert!(f
        .state
        .begin_with(&f.backend, "", "", "BlackHole 2ch")
        .is_err());
    assert!(f
        .backend
        .writes
        .borrow()
        .contains(&("input".into(), "mic-id".into())));
    assert!(f.state.read().unwrap().unwrap().force_restore);
    // Even an OS update arriving after the failed start remains recoverable.
    f.backend.defaults.borrow_mut()[0].id = "cable-id".into();
    f.state.restore_with(&f.backend, None).unwrap();
    assert_eq!(f.backend.defaults.borrow()[0].id, "mic-id");
    assert!(!f.state.path.exists());
}

#[test]
fn setter_confirmation_requires_stable_observations() {
    let mut observations = 0;
    confirm_default(|| {
        observations += 1;
        Ok(observations != 2)
    })
    .unwrap();
    assert!(observations >= 7);
}
