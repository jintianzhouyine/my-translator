# Hướng dẫn cài đặt — Windows

[简体中文](installation_guide_win.md) | [English](installation_guide_win.en.md) | **Tiếng Việt (bản cũ)**

> Tài liệu tiếng Việt này được giữ lại từ phiên bản cũ; thông tin về engine, kiến trúc, chi phí và cập nhật có thể đã lỗi thời. Hãy xem hướng dẫn tiếng Trung hoặc tiếng Anh ở trên cho phiên bản hiện tại.

Hướng dẫn từng bước cài đặt và sử dụng **My Translator** trên Windows 10/11.

---

## Yêu cầu

- Windows 10 trở lên (x64 hoặc ARM64)
- **Soniox** (khuyên dùng): API key từ [Soniox](https://soniox.com) (trả theo dùng, ~$0.12/giờ)
- **OpenAI Realtime** (cao cấp): API key từ [OpenAI](https://platform.openai.com) (~$4/giờ — đắt hơn nhiều, nhưng có sẵn giọng nói dịch — không cần TTS riêng)
- **Thuyết minh TTS** (tuỳ chọn, dành cho engine text): Edge TTS (miễn phí) hoặc ElevenLabs/Google. Xem [Hướng dẫn TTS](tts_guide_vi.md)

---

## Bước 1 — Tải xuống

Tải file `.exe` mới nhất tại: [**Releases — Windows**](https://github.com/jintianzhouyine/my-translator/releases/latest)

Chọn phiên bản phù hợp:
- **x64** — Đa số PC Windows (Intel/AMD)
- **arm64** — Windows trên ARM (Surface Pro X, laptop Snapdragon)

---

## Bước 2 — Bỏ qua SmartScreen

> ⚠️ Ứng dụng chưa có chữ ký số. Windows SmartScreen sẽ chặn lần chạy đầu tiên.

Khi thấy màn hình **"Windows protected your PC"**:

1. Nhấn **"More info"** (Thêm thông tin)

![SmartScreen — nhấn More info](user_manual_win/mytrans_win_01.png)

2. Nhấn **"Run anyway"** (Vẫn chạy)

![Nhấn Run anyway](user_manual_win/mytrans_win_02.png)

---

## Bước 3 — Cài đặt

Trình cài đặt sẽ hướng dẫn bạn:

1. Nhấn **Next** để bắt đầu

![Welcome to My Translator Setup](user_manual_win/mytrans_win_03.png)

2. Chọn thư mục cài đặt (để mặc định là được) → nhấn **Next**

![Chọn thư mục cài đặt](user_manual_win/mytrans_win_04.png)

3. Đợi cài đặt hoàn tất → nhấn **Next**

![Cài đặt hoàn tất](user_manual_win/mytrans_win_05.png)

4. Tích **"Run My Translator"** → nhấn **Finish**

![Hoàn thành — Chạy My Translator](user_manual_win/mytrans_win_06.png)

---

## Bước 4 — Cấu hình API Key và ngôn ngữ

Ứng dụng mở lên. Nhấn ⚙️ để mở **Settings** (Cài đặt).

Cấu hình:

1. **API KEYS** — Dán ít nhất một trong:
   - **Soniox API key** — mặc định khuyên dùng (~$0.12/giờ)
   - **OpenAI API key** — engine cao cấp có sẵn giọng nói dịch (~$4/giờ — xem cảnh báo bên dưới)
   - Dấu chấm xanh ✓ cạnh ô key nghĩa là định dạng key hợp lệ; bấm **Test** để kiểm tra kết nối thật. Engine không có key hợp lệ sẽ bị mờ trong dropdown.
2. **Translation Engine** — chọn giữa:
   - ☁️ **Soniox** (cloud, ~$0.12/giờ, độ trễ ~2 giây, hỗ trợ chế độ two-way)
   - ⚡ **OpenAI Realtime** (cloud, ~$4/giờ, độ trễ ~1.5 giây, **có sẵn giọng nói** — không hỗ trợ two-way và TTS tuỳ chỉnh)
3. **Source** — Chọn ngôn ngữ nguồn (hoặc để Auto-detect - tự nhận diện)
4. **Target** — Chọn ngôn ngữ đích (VD: Vietnamese, English...)
5. **Audio Source** — Chọn System Audio (âm thanh máy tính) hoặc Microphone

![Settings — API Key và ngôn ngữ](user_manual/mytrans_setting_1.png)

Kéo xuống để xem thêm tuỳ chọn:

- **Font Size** — Điều chỉnh cỡ chữ
- **Max Lines** — Số dòng hiển thị tối đa
- **Show original text** — Hiện text gốc bên cạnh bản dịch
- **Custom Context** — Thêm lĩnh vực/thuật ngữ để dịch chính xác hơn

![Settings — TTS Narration](user_manual/mytrans_setting_2.png)

Nhấn **Save & Close** khi xong.

> 💡 **Lấy API key Soniox ở đâu?**
> 1. Vào [console.soniox.com](https://console.soniox.com) → tạo tài khoản
> 2. Nạp tiền ($10 tối thiểu, dùng rất lâu với ~$0.12/giờ)
> 3. Vào **API Keys** → tạo và copy key

![Soniox Console — Billing](user_manual/mytrans_key_1.png)

> 💡 **Lấy API key OpenAI ở đâu?**
> 1. Vào [platform.openai.com](https://platform.openai.com) → tạo tài khoản
> 2. **Settings → Billing** → thêm phương thức thanh toán và nạp credit ($10 ≈ ~2.5 giờ)
> 3. **API keys** → **Create new secret key** → copy key (`sk-...`)
>
> ⚠️ **Cảnh báo chi phí**: OpenAI Realtime đắt hơn Soniox khoảng 34 lần. Phù hợp cho cuộc họp quan trọng cần chất lượng tốt nhất; dùng hàng ngày nên chọn Soniox. Xem [**Báo cáo benchmark lịch sử OpenAI vs Soniox**](../benchmarks/benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.en.md) để có chi tiết.

Sau khi lưu OpenAI key hợp lệ, engine **OpenAI Realtime** sẽ chọn được trong dropdown:

![Settings — Engine OpenAI Realtime kèm API key](user_manual/setting_openai.png)

---

## Bước 5 — Bật Thuyết Minh TTS (Tuỳ chọn)

Muốn bản dịch được **đọc thành lời**? Bật tính năng TTS:

1. Trong Settings, cuộn xuống phần **TTS Narration**
2. Tick **"Đọc bản dịch thành lời (Enable narration)"**

![Cài đặt — TTS tắt](user_manual/mytrans_setting_2.png)

3. Nhập **API key ElevenLabs**
4. Chọn **giọng nói** (2 nữ, 2 nam — đều hỗ trợ tiếng Việt)
5. Nhấn **Save & Close**

![Cài đặt — TTS bật với API key và giọng nói](user_manual/mytrans_setting_3.png)

> 💡 **Lấy API key ElevenLabs ở đâu?**
> 1. Vào [elevenlabs.io](https://elevenlabs.io) → tạo tài khoản
> 2. Đăng ký gói **Starter** ($5/tháng, ~60 phút TTS)
> 3. Vào **Developers → API Keys** → tạo key với quyền "Text to Speech"

![ElevenLabs — Gói Subscription](user_manual/mytrans_key_2.png)
![ElevenLabs — Tạo API Key](user_manual/mytrans_key_3.png)

> 💡 TTS là tuỳ chọn. Nếu tắt, app hoạt động như bình thường — chỉ dịch text.

---

## Bước 6 — Bắt đầu dịch!

Nhấn ▶ để bắt đầu. Ứng dụng sẽ hiện **Listening...**

Giờ phát bất kỳ âm thanh nào trên PC (YouTube, Zoom, podcast...) và bản dịch sẽ xuất hiện theo thời gian thực!

Nếu TTS đã bật, bạn có thể bật/tắt bằng nút **TTS** hoặc `Ctrl+T`.

![App đang dịch với TTS bật](user_manual/mytrans_tts_1.png)

### Chọn chế độ dịch

Nếu đã cấu hình cả Soniox và OpenAI key, lần đầu bắt đầu phiên dịch, app sẽ hỏi chọn engine nào:

![Chọn chế độ dịch — Standard vs OpenAI Realtime](user_manual/openao_entry.png)

Bạn có thể đổi engine bất cứ lúc nào qua nút engine ở thanh toolbar.

### Chế độ Dual-panel với OpenAI Realtime

Ở chế độ **Dual**, transcript nguồn hiển thị bên trái, bản dịch bên phải — whisper transcription và bản dịch của OpenAI chạy song song:

![Dual-panel chạy với OpenAI Realtime](user_manual/openai_translate.png)

---

## Mẹo sử dụng

- **System Audio** bắt tất cả âm thanh đang phát trên PC — không cần virtual cable
- **Microphone** bắt giọng nói trực tiếp từ mic
- **TTS** đọc bản dịch thành lời — bật/tắt bằng nút TTS hoặc `Ctrl+T`
- Ứng dụng hoạt động như **overlay** — kéo thả tự do, thay đổi kích thước tuỳ ý
- Bản dịch được **lưu tự động** — nhấn 📋 để xem file transcript

---

## Phím tắt

| Phím tắt | Chức năng |
|----------|-----------|
| `Ctrl+Enter` | Bắt đầu / Dừng |
| `Ctrl+,` | Mở Settings |
| `Esc` | Đóng Settings |
| `Ctrl+T` | Bật/tắt thuyết minh TTS |

---

## Khắc phục sự cố

### SmartScreen chặn trình cài đặt
→ Nhấn **"More info"** → **"Run anyway"** (xem Bước 2).

### Không hiện bản dịch
→ Kiểm tra API key của engine đang chọn đã đúng trong Settings (⚙️). Bấm **Test** để xác nhận kết nối.

### OpenAI Realtime: option engine bị mờ
→ Chưa nhập OpenAI key hoặc key sai định dạng (phải bắt đầu bằng `sk-`). Dán key mới rồi bấm **Test**.

### OpenAI Realtime: nút "Two-way" biến mất
→ Đây là hành vi mong đợi. Two-way chỉ khả dụng với Soniox. Đổi engine nếu cần.

### Chi phí cao hơn dự tính
→ Kiểm tra engine đang dùng. OpenAI Realtime ~$4/giờ vs Soniox ~$0.12/giờ.

### Không bắt được âm thanh hệ thống
→ Đảm bảo đang phát audio trên PC. Một số ứng dụng dùng exclusive audio mode — thử nguồn audio khác.

### Ứng dụng không mở
→ Đảm bảo WebView2 Runtime đã cài. Windows 10/11 thường có sẵn, nhưng phiên bản cũ cần cài từ [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

---

## Cập nhật

My Translator có tính năng **tự động cập nhật**. Khi có bản mới:

1. **Badge xanh** xuất hiện trên icon ⚙️ Settings
2. Mở Settings → tab **About** → bấm **Download & Install**
3. App sẽ tự khởi động lại với bản mới

Không cần tải installer thủ công cho các bản cập nhật sau!
