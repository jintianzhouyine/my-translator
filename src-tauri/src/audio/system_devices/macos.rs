use super::{Backend, DefaultDevice, Device, DeviceChangeError};
use std::{
    ffi::{c_char, c_void},
    mem::size_of,
    ptr,
};

// CoreAudio/AudioHardware.h and CoreFoundation/CFString.h. These are the public
// HAL APIs; no shell utility or administrator privilege is required.
#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}
const SYSTEM: u32 = 1;
const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const INPUT: u32 = u32::from_be_bytes(*b"inpt");
const OUTPUT: u32 = u32::from_be_bytes(*b"outp");
const DEVICES: u32 = u32::from_be_bytes(*b"dev#");
const NAME: u32 = u32::from_be_bytes(*b"lnam");
const UID: u32 = u32::from_be_bytes(*b"uid ");
const STREAMS: u32 = u32::from_be_bytes(*b"stm#");
const TRANSPORT: u32 = u32::from_be_bytes(*b"tran");
const UTF8: u32 = 0x0800_0100;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn AudioObjectSetPropertyData(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetLength(value: *const c_void) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(
        value: *const c_void,
        buffer: *mut c_char,
        length: isize,
        encoding: u32,
    ) -> bool;
    fn CFRelease(value: *const c_void);
}

fn address(selector: u32, scope: u32) -> Address {
    Address {
        selector,
        scope,
        element: 0,
    }
}
fn check(status: i32) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("CoreAudio 音频设备操作失败（{status}）"))
    }
}
fn size(object: u32, selector: u32, scope: u32) -> Result<u32, String> {
    let mut bytes = 0;
    unsafe {
        check(AudioObjectGetPropertyDataSize(
            object,
            &address(selector, scope),
            0,
            ptr::null(),
            &mut bytes,
        ))?;
    }
    Ok(bytes)
}
fn scalar<T: Copy + Default>(object: u32, selector: u32) -> Result<T, String> {
    let mut value = T::default();
    let mut bytes = size_of::<T>() as u32;
    unsafe {
        check(AudioObjectGetPropertyData(
            object,
            &address(selector, GLOBAL),
            0,
            ptr::null(),
            &mut bytes,
            (&mut value as *mut T).cast(),
        ))?;
    }
    if bytes as usize != size_of::<T>() {
        return Err("CoreAudio 返回的设备属性大小不正确".into());
    }
    Ok(value)
}
fn string(object: u32, selector: u32) -> Result<String, String> {
    let value: *const c_void = scalar(object, selector)?;
    if value.is_null() {
        return Err("CoreAudio 返回了空设备标识".into());
    }
    unsafe {
        let length = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) + 1;
        if !(1..=1024 * 1024).contains(&length) {
            CFRelease(value);
            return Err("设备标识长度不正确".into());
        }
        let mut bytes = vec![0u8; length as usize];
        let ok = CFStringGetCString(value, bytes.as_mut_ptr().cast(), length, UTF8);
        CFRelease(value);
        if !ok {
            return Err("无法读取音频设备名称".into());
        }
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        String::from_utf8(bytes[..end].to_vec()).map_err(|e| e.to_string())
    }
}
fn device_ids() -> Result<Vec<u32>, String> {
    let mut bytes = size(SYSTEM, DEVICES, GLOBAL)?;
    let mut ids = vec![0u32; bytes as usize / size_of::<u32>()];
    unsafe {
        check(AudioObjectGetPropertyData(
            SYSTEM,
            &address(DEVICES, GLOBAL),
            0,
            ptr::null(),
            &mut bytes,
            ids.as_mut_ptr().cast(),
        ))?;
    }
    ids.truncate(bytes as usize / size_of::<u32>());
    Ok(ids)
}
fn selector(key: &str) -> Result<u32, String> {
    match key {
        "input" => Ok(u32::from_be_bytes(*b"dIn ")),
        "output" => Ok(u32::from_be_bytes(*b"dOut")),
        "system-output" => Ok(u32::from_be_bytes(*b"sOut")),
        _ => Err("不支持的 macOS 音频设备角色".into()),
    }
}

pub(super) struct NativeBackend;
impl NativeBackend {
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }
}
impl Backend for NativeBackend {
    fn devices(&self) -> Result<Vec<Device>, String> {
        let mut devices = Vec::new();
        for object in device_ids()? {
            let name = string(object, NAME)?;
            let transport: u32 = scalar(object, TRANSPORT)?;
            devices.push(Device {
                id: string(object, UID)?,
                name,
                input: size(object, STREAMS, INPUT)? > 0,
                output: size(object, STREAMS, OUTPUT)? > 0,
                virtual_device: [u32::from_be_bytes(*b"virt"), u32::from_be_bytes(*b"grup")]
                    .contains(&transport),
            });
        }
        Ok(devices)
    }
    fn defaults(&self) -> Result<Vec<DefaultDevice>, String> {
        let mut defaults = Vec::new();
        for key in ["input", "output", "system-output"] {
            let object: u32 = scalar(SYSTEM, selector(key)?)?;
            // No currently available endpoint for this role. Other roles
            // must still be recoverable after a headset is unplugged.
            if object == 0 {
                continue;
            }
            defaults.push(DefaultDevice {
                key: key.to_string(),
                id: string(object, UID)?,
            });
        }
        Ok(defaults)
    }
    fn set_default(&self, key: &str, id: &str) -> Result<(), DeviceChangeError> {
        let object = device_ids()?
            .into_iter()
            .find(|object| string(*object, UID).as_deref() == Ok(id))
            .ok_or_else(|| format!("要恢复的音频设备已断开（{key}）"))?;
        let property = selector(key)?;
        unsafe {
            check(AudioObjectSetPropertyData(
                SYSTEM,
                &address(property, GLOBAL),
                0,
                ptr::null(),
                size_of::<u32>() as u32,
                (&object as *const u32).cast(),
            ))?;
        }
        super::confirm_default(|| Ok(scalar::<u32>(SYSTEM, property)? == object))
    }
    fn paired_input<'a>(
        &self,
        output: &Device,
        devices: &'a [Device],
    ) -> Result<&'a Device, String> {
        if !output.name.starts_with("BlackHole ") || !output.virtual_device {
            return Err("自动切换目前支持 BlackHole；其他虚拟设备请关闭「通话时设为系统默认麦克风」选项并手动设置系统麦克风".into());
        }
        devices
            .iter()
            .find(|d| d.id == output.id && d.input)
            .ok_or_else(|| "所选 BlackHole 没有对应的输入端，请重新安装或选择设备".into())
    }
}
