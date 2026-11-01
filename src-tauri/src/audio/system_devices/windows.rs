use super::{Backend, DefaultDevice, Device, DeviceChangeError};
use std::ffi::c_void;
use windows::{
    core::{IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT, PCWSTR},
    Win32::{
        Media::Audio::{
            eCapture, eCommunications, eConsole, eMultimedia, eRender, ERole, IMMDevice,
            IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_MULTITHREADED, STGM_READ,
        },
        UI::Shell::PropertiesSystem::PROPERTYKEY,
    },
};

// Windows has no public API for changing global defaults. Keep this established
// Windows 10/11 IPolicyConfig ABI in one place; unsupported systems return an
// error before routing and users can disable automatic device management.
// SetDefaultEndpoint is slot 13 (IUnknown plus ten preceding methods).
#[repr(transparent)]
#[derive(Clone)]
struct PolicyConfig(IUnknown);
unsafe impl Interface for PolicyConfig {
    type Vtable = PolicyVtable;
    const IID: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
}
#[repr(C)]
struct PolicyVtable {
    base: IUnknown_Vtbl,
    preceding_methods: [usize; 10],
    set_default: unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> HRESULT,
    set_visibility: usize,
}
const POLICY_CLASS: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

struct ComGuard(bool);
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}
pub(super) struct NativeBackend {
    enumerator: IMMDeviceEnumerator,
    // Fields are dropped in declaration order: release the interface before COM.
    _com: ComGuard,
}
fn error(e: windows::core::Error) -> String {
    format!("Windows 音频设备操作失败：{e}")
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn device_id(device: &IMMDevice) -> Result<String, String> {
    unsafe {
        let text = device.GetId().map_err(error)?;
        let result = text.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(text.as_ptr().cast()));
        result
    }
}
impl NativeBackend {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            // An existing STA is also usable; never uninitialize somebody else's apartment.
            if hr.is_err() && hr.0 as u32 != 0x80010106 {
                return Err(format!("无法初始化音频设备接口：{hr}"));
            }
            let com = ComGuard(hr.is_ok());
            let enumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(error)?;
            Ok(Self {
                enumerator,
                _com: com,
            })
        }
    }
}
fn role(key: &str) -> Result<ERole, String> {
    match key.rsplit('-').next() {
        Some("console") => Ok(eConsole),
        Some("multimedia") => Ok(eMultimedia),
        Some("communications") => Ok(eCommunications),
        _ => Err("不支持的 Windows 音频设备角色".into()),
    }
}
fn cable_input_name(output: &str) -> Option<String> {
    // Known VB-CABLE products use two distinct endpoint names. Requiring exact,
    // unique product names prevents selecting a different cable or any random mic.
    let products = [
        ("CABLE", "VB-Audio Virtual Cable"),
        ("CABLE-A", "VB-Audio Cable A"),
        ("CABLE-B", "VB-Audio Cable B"),
        ("CABLE-C", "VB-Audio Cable C"),
        ("CABLE-D", "VB-Audio Cable D"),
    ];
    products.iter().find_map(|(prefix, product)| {
        if output == format!("{prefix} Input ({product})") {
            Some(format!("{prefix} Output ({product})"))
        } else {
            None
        }
    })
}
impl Backend for NativeBackend {
    fn devices(&self) -> Result<Vec<Device>, String> {
        unsafe {
            let mut devices = Vec::new();
            for (flow, input) in [(eCapture, true), (eRender, false)] {
                let collection = self
                    .enumerator
                    .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                    .map_err(error)?;
                for i in 0..collection.GetCount().map_err(error)? {
                    let device = collection.Item(i).map_err(error)?;
                    let properties = device.OpenPropertyStore(STGM_READ).map_err(error)?;
                    let name = properties
                        .GetValue(&FRIENDLY_NAME)
                        .map_err(error)?
                        .to_string();
                    let lower = name.to_ascii_lowercase();
                    let virtual_device = ["vb-audio", "voicemeeter", "virtual", "blackhole"]
                        .iter()
                        .any(|word| lower.contains(word));
                    devices.push(Device {
                        id: device_id(&device)?,
                        name,
                        input,
                        output: !input,
                        virtual_device,
                    });
                }
            }
            Ok(devices)
        }
    }
    fn defaults(&self) -> Result<Vec<DefaultDevice>, String> {
        let mut defaults = Vec::new();
        for (flow, prefix) in [(eCapture, "input"), (eRender, "output")] {
            for (role, suffix) in [
                (eConsole, "console"),
                (eMultimedia, "multimedia"),
                (eCommunications, "communications"),
            ] {
                let device = match unsafe { self.enumerator.GetDefaultAudioEndpoint(flow, role) } {
                    Ok(device) => device,
                    // E_NOTFOUND: a disconnected endpoint must not prevent
                    // restoring the remaining capture/playback roles.
                    Err(e) if e.code().0 as u32 == 0x80070490 => continue,
                    Err(e) => return Err(error(e)),
                };
                defaults.push(DefaultDevice {
                    key: format!("{prefix}-{suffix}"),
                    id: device_id(&device)?,
                });
            }
        }
        Ok(defaults)
    }
    fn set_default(&self, key: &str, id: &str) -> Result<(), DeviceChangeError> {
        let role = role(key)?;
        let wide = wide(id);
        unsafe {
            let endpoint = self
                .enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(error)?;
            if endpoint.GetState().map_err(error)? != DEVICE_STATE_ACTIVE {
                return Err(format!("要恢复的音频设备已断开（{key}）").into());
            }
            let policy: PolicyConfig =
                CoCreateInstance(&POLICY_CLASS, None, CLSCTX_ALL).map_err(error)?;
            (policy.vtable().set_default)(policy.as_raw(), PCWSTR(wide.as_ptr()), role)
                .ok()
                .map_err(error)?;
            let flow = if super::is_input(key) {
                eCapture
            } else {
                eRender
            };
            super::confirm_default(|| {
                let actual = self
                    .enumerator
                    .GetDefaultAudioEndpoint(flow, role)
                    .map_err(error)?;
                Ok(device_id(&actual)? == id)
            })?;
        }
        Ok(())
    }
    fn paired_input<'a>(
        &self,
        output: &Device,
        devices: &'a [Device],
    ) -> Result<&'a Device, String> {
        let input = cable_input_name(&output.name).ok_or_else(|| "自动切换目前支持标准名称的 VB-CABLE；其他设备请关闭「通话时设为系统默认麦克风」选项并手动设置系统麦克风".to_string())?;
        super::named_device(devices, &input, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_cable_pairing_never_crosses_products_or_guesses_renamed_devices() {
        assert_eq!(
            cable_input_name("CABLE Input (VB-Audio Virtual Cable)").as_deref(),
            Some("CABLE Output (VB-Audio Virtual Cable)")
        );
        assert_eq!(
            cable_input_name("CABLE-B Input (VB-Audio Cable B)").as_deref(),
            Some("CABLE-B Output (VB-Audio Cable B)")
        );
        assert!(cable_input_name("Speakers").is_none());
        assert!(cable_input_name("CABLE-A Input (VB-Audio Cable B)").is_none());
    }
}
