# Hướng Dẫn Cài Đặt My Translator

[简体中文](installation_guide.md) | [English](installation_guide.en.md) | **Tiếng Việt (bản cũ)**

> Tài liệu tiếng Việt này được giữ lại từ phiên bản cũ; thông tin về engine, kiến trúc, chi phí và cập nhật có thể đã lỗi thời. Hãy xem hướng dẫn tiếng Trung hoặc tiếng Anh ở trên cho phiên bản hiện tại.

Hướng dẫn từng bước cài đặt và sử dụng **My Translator** trên macOS.

---

## Yêu cầu

- macOS 13 trở lên (Apple Silicon — chip M1/M2/M3/M4)
- **Soniox** (khuyên dùng): API key của [Soniox](https://soniox.com) (trả theo dùng, ~$0.12/giờ)
- **OpenAI Realtime** (cao cấp): API key của [OpenAI](https://platform.openai.com) (~$4/giờ — đắt hơn nhiều, nhưng có sẵn giọng nói dịch)
- **Qwen LiveTranslate Flash** (miễn phí preview): API key DashScope từ [Alibaba Cloud Model Studio](https://bailian.console.alibabacloud.com) (region **Singapore**, 60+ ngôn ngữ, nhanh nhất, text-only)
- **Chế độ Local**: ~5 GB dung lượng ổ cứng (cho mô hình AI, tải một lần)
- **Thuyết minh TTS** (tuỳ chọn, dành cho engine text): Xem [Hướng dẫn TTS](tts_guide_vi.md)

---

## Bước 1 — Tải về

Tải file `.dmg` mới nhất tại: [**Releases — macOS**](https://github.com/jintianzhouyine/my-translator/releases/latest)

Chọn đúng file:
- `MyTranslator_x.x.x_aarch64.dmg` — Apple Silicon (M1/M2/M3/M4)
- `MyTranslator_x.x.x_x64.dmg` — Intel Mac

---

## Bước 2 — Cài đặt

1. Mở file `.dmg` vừa tải
2. Kéo **My Translator** vào thư mục **Applications**
3. Eject DMG

---

## Bước 3 — Mở lần đầu

Mở My Translator từ Applications.

> ✅ App đã được ký và notarize — macOS sẽ cho phép mở mà không cảnh báo bảo mật.

---

## Bước 4 — Cấp quyền Screen Recording

Lần đầu mở app, macOS sẽ hỏi quyền **Screen & System Audio Recording**:

1. Bấm **Open System Settings** khi được hỏi
2. Tìm **My Translator** trong danh sách
3. **Bật công tắc ON**
4. macOS sẽ yêu cầu **Quit & Reopen** — bấm nút đó

> Quyền này bắt buộc để app bắt được âm thanh hệ thống (YouTube, Zoom, podcast, v.v.)

---

## Bước 5 — Lấy API Key Soniox

Soniox cung cấp nhận diện giọng nói và dịch real-time.

1. Vào [console.soniox.com](https://console.soniox.com) → tạo tài khoản
2. Nạp tiền:
   - Click **Billing** ở thanh bên trái
   - Thêm phương thức thanh toán
   - Nạp tiền ($10 tối thiểu — dùng được ~80+ giờ với ~$0.12/giờ)
3. Tạo API key:
   - Click **API Keys** ở thanh bên trái
   - Click **Create API Key**
   - Copy key (dạng `soniox_...`)

> 💡 Soniox tính ~$0.12/giờ audio. $10 ≈ 80+ giờ dịch.

Sau khi dán Soniox key vào Settings, engine **Soniox** sẽ là lựa chọn đang hoạt động:

![Settings — Engine Soniox được chọn kèm API key](user_manual/setting_soniox.png)

---

## Bước 5b — Lấy API Key OpenAI (Tuỳ chọn)

Bỏ qua bước này nếu chỉ định dùng Soniox hoặc Local mode.

OpenAI Realtime là engine **cao cấp** — trả về cả văn bản dịch **và giọng nói dịch** trên cùng một stream, không cần TTS riêng. Đánh đổi: chi phí khoảng **$4/giờ**, đắt hơn Soniox khoảng **34 lần**.

1. Vào [platform.openai.com](https://platform.openai.com) → tạo tài khoản
2. Nạp tiền:
   - Click **Settings → Billing**
   - Thêm phương thức thanh toán và nạp credit ($10 ≈ ~2.5 giờ dịch)
3. Tạo API key:
   - Click **API keys** → **Create new secret key**
   - Copy key (dạng `sk-...`)

> ⚠️ **Cảnh báo chi phí**: OpenAI Realtime đắt hơn Soniox khoảng 34 lần. Phù hợp cho cuộc họp quan trọng cần chất lượng dịch và giọng nói tốt nhất. Dùng hàng ngày, Soniox vẫn là lựa chọn mặc định tốt hơn.
>
> 📊 Xem [**Báo cáo benchmark lịch sử OpenAI Realtime vs Soniox**](../benchmarks/benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.en.md) để so sánh thực tế.

Sau khi dán OpenAI key vào Settings, engine **OpenAI Realtime** sẽ chọn được:

![Settings — Chọn engine OpenAI Realtime kèm API key](user_manual/setting_openai.png)

---

## Bước 5c — Lấy API Key Qwen LiveTranslate Flash (Tuỳ chọn, miễn phí)

Qwen LiveTranslate Flash (Alibaba DashScope) là engine **miễn phí trong giai đoạn preview** — nhanh nhất trong ba engine (~4 giây), hỗ trợ **60+ ngôn ngữ**, chỉ trả về văn bản dịch (không có giọng nói, không có dual-panel source).

> ⚠️ **QUAN TRỌNG — phải chọn region Singapore.** App kết nối tới endpoint quốc tế `dashscope-intl.aliyuncs.com`. Key tạo ở region khác (China Beijing, Hong Kong, US Virginia, Germany Frankfurt) sẽ bị reject và app báo `WebSocket error` ngay khi bấm Start.

1. Mở <https://bailian.console.alibabacloud.com> (Alibaba Cloud Model Studio).
2. **Trước khi đăng nhập / đăng ký**, bấm dropdown region ở góc trên bên phải và chọn **Singapore**. Nếu lỡ login ở region khác rồi, switch sang Singapore — có thể phải đăng ký workspace riêng cho region này.
3. Sau khi vào Console (đảm bảo góc trên vẫn hiển thị "Singapore"), kích hoạt dịch vụ **Model Studio (DashScope)** nếu được nhắc.
4. Vào mục **API Keys**, bấm **Create API Key**, đặt tên bất kỳ.
5. **Sao chép key ngay** — chỉ hiển thị đầy đủ một lần.
6. Vào Settings → chọn engine **Qwen LiveTranslate Flash** → dán key.

![Settings — Engine Qwen LiveTranslate Flash kèm API key](user_manual/setting_qwen.png)

> **Lưu ý Qwen Live Flash:**
> - **Phải chọn source language** trước khi Start. Không như Soniox/OpenAI có auto-detect, Qwen Live cần biết rõ ngôn ngữ nguồn — picker source language sẽ tự động ẩn option "Auto-detect" khi chọn engine này.
> - **Không có dual panel** (model chỉ trả về translation, không có source transcript). Chỉ hiển thị bản dịch.
> - **Không có TTS giọng nói** — tránh feedback loop (loa → mic → loa…).
> - Hiện ở giai đoạn **preview (miễn phí)**. Giá có thể thay đổi khi rời preview — theo dõi thông báo của Alibaba Cloud.

### Khắc phục lỗi `WebSocket error` khi dùng Qwen

| Triệu chứng | Nguyên nhân thường gặp | Cách sửa |
| --- | --- | --- |
| Báo `WebSocket error` ngay khi bấm Start | Key tạo ở region khác Singapore | Tạo lại key ở region Singapore (xem mục 2 ở trên) |
| Báo lỗi sau ~5–10 giây | Key đúng region nhưng chưa kích hoạt model Qwen Live | Vào Model Studio → Model Square → bật `qwen3-livetranslate-flash-realtime` |
| Dịch được 1 câu rồi stall | Source language để "auto" thay vì chọn rõ ngôn ngữ | Settings → Source language → chọn cụ thể (vd: Japanese) |
| Báo lỗi không ổn định | Mạng chặn `dashscope-intl.aliyuncs.com` (firewall công ty / VPN) | Thử mạng khác (4G/5G) hoặc tắt VPN |

---

## Bước 6 — Cấu hình App

1. Bấm ⚙️ (hoặc `⌘ ,`) để mở **Settings**
2. Vào tab **General**
3. Dán **Soniox API key** và/hoặc **OpenAI API key** (tuỳ engine bạn muốn bật)
   - Dấu chấm xanh ✓ cạnh ô key nghĩa là định dạng key hợp lệ; bấm **Test** để ping thật tới provider
   - Engine không có key hợp lệ sẽ bị mờ trong dropdown
4. Chọn kiểu dịch:
   - **One-way** (Một chiều): Chọn ngôn ngữ nguồn và ngôn ngữ đích
   - **Two-way** (Hai chiều): Chọn Language A và Language B (dành cho meeting song ngữ — app tự nhận diện ai đang nói và dịch sang ngôn ngữ còn lại). *Two-way không khả dụng với OpenAI Realtime — dùng Soniox hoặc Local nếu cần two-way.*
5. Chọn Translation Engine:

| Chế độ | Tốc độ | Chất lượng | Chi phí | Giọng nói | Source transcript | Internet |
|--------|--------|------------|---------|-----------|-------------------|----------|
| ☁️ **Soniox** | ~2 giây | 9/10 | ~$0.12/giờ | Qua TTS (miễn phí–$8/giờ) | ✅ Có (dual panel) | Cần |
| ⚡ **OpenAI Realtime** | ~1.5 giây | 9.5/10, dịch rất tự nhiên | **~$4/giờ** | Tắt mặc định | ✅ Có (dual panel) | Cần |
| 🌏 **Qwen LiveTranslate Flash** | ~4 giây | 8/10, 60+ ngôn ngữ | **Miễn phí (preview)** | ❌ Không có | ❌ Không có (chỉ dịch) | Cần |
| 🖥️ **Local MLX** | ~10 giây | 7/10 | Miễn phí | Qua TTS | ✅ Có | Không cần |

6. Bấm **Save & Close**

> **Local MLX** yêu cầu Apple Silicon (M1+) và ~5 GB ổ cứng. Model tự tải lần đầu.
>
> **OpenAI Realtime** hỗ trợ 13 ngôn ngữ đích: en, es, pt, fr, de, it, ru, hi, id, vi, ja, ko, zh. Cho tiếng Thái hoặc các ngôn ngữ khác, dùng Soniox. Tuỳ chọn TTS tự động bị tắt khi chọn OpenAI Realtime (giọng nói đã có sẵn từ model).

---

## Bước 7 — Bật Thuyết Minh TTS (Tuỳ chọn)

Muốn bản dịch được **đọc thành lời**? Có 3 nhà cung cấp:

| Nhà cung cấp | Chi phí | Chất lượng | Cài đặt |
|---------------|---------|------------|---------|
| 🎙️ **Edge TTS** | Miễn phí | Tự nhiên | Không cần gì |
| 🌐 **Google Chirp 3 HD** | Free 1M ký tự/tháng | Gần giọng người | Cần Google Cloud API key |
| ✨ **ElevenLabs** | ~$5/tháng trở lên | Cao cấp | Cần ElevenLabs API key |

### Cài nhanh (Edge TTS — miễn phí):

1. Settings → tab **TTS** → Provider: **Edge TTS**
2. Chọn giọng → **Save & Close**
3. Trên màn hình chính, bấm nút **TTS** (hoặc `⌘ T`) để bật

### Google hoặc ElevenLabs:

Xem [Hướng dẫn TTS](tts_guide_vi.md) để biết cách lấy API key từng bước.

---

## Bước 8 — Bắt đầu dịch!

1. Quay lại màn hình chính
2. Bấm ▶ (hoặc `⌘ Enter`) để bắt đầu
3. Phát bất kỳ audio nào trên máy (YouTube, Zoom, podcast...)
4. Bản dịch xuất hiện real-time!

**Chế độ hiển thị:**
- **Single** (mặc định): Chỉ bản dịch
- **Dual**: Nguồn | Bản dịch song song (bật bằng nút panel, góc dưới phải)

**Cỡ chữ:** Dùng nút A-/A+ (góc dưới phải khi hover) để chỉnh

### Chọn chế độ dịch

Nếu đã cấu hình cả Soniox và OpenAI key, lần đầu bắt đầu phiên dịch, app sẽ hỏi chọn engine nào:

![Chọn chế độ dịch — Standard vs OpenAI Realtime](user_manual/openao_entry.png)

Bạn có thể đổi engine bất cứ lúc nào qua nút engine ở thanh toolbar.

### Chế độ Dual-panel với OpenAI Realtime

Ở chế độ **Dual**, transcript nguồn hiển thị bên trái, bản dịch bên phải — whisper transcription và bản dịch của OpenAI chạy song song:

![Dual-panel chạy với OpenAI Realtime](user_manual/openai_translate.png)

---

## Phím tắt

| Phím tắt | Chức năng |
|----------|-----------|
| `⌘ Enter` | Bắt đầu / Dừng |
| `⌘ ,` | Mở Settings |
| `Esc` | Đóng Settings |
| `⌘ 1` | Chuyển sang System Audio |
| `⌘ 2` | Chuyển sang Microphone |
| `⌘ T` | Bật/tắt thuyết minh TTS |

---

## Xử lý sự cố

### Không có bản dịch / không hiện text
→ Kiểm tra đã bật quyền **Screen & System Audio Recording** chưa (xem Bước 4)

### Lỗi "No API key"
→ Vào Settings (⚙️) và dán Soniox key (Bước 5) và/hoặc OpenAI key (Bước 5b) tuỳ theo engine đang chọn

### OpenAI Realtime: option engine bị mờ
→ Chưa nhập OpenAI key hoặc key sai định dạng (phải bắt đầu bằng `sk-`). Dán key mới rồi bấm **Test** để xác nhận

### OpenAI Realtime: nút "Two-way" biến mất
→ Đây là hành vi mong đợi. Two-way chỉ khả dụng với Soniox và Local MLX. Đổi engine nếu cần

### Chi phí cao hơn dự tính
→ Kiểm tra engine đang dùng. OpenAI Realtime ~$4/giờ vs Soniox ~$0.12/giờ. Engine hiện tại hiển thị dưới dropdown trong Settings

### Lỗi "No microphone found"
→ Mac Mini không có mic tích hợp. Cần kết nối mic ngoài (USB, headset, AirPods)

### TTS không hoạt động
→ Xem [Hướng dẫn TTS — Xử lý sự cố](tts_guide_vi.md#xử-lý-sự-cố)

---

## Cập nhật

My Translator có tính năng **tự động cập nhật**. Khi có bản mới:

1. **Badge xanh** xuất hiện trên icon ⚙️ Settings
2. Mở Settings → tab **About** → bấm **Download & Install**
3. App sẽ tự khởi động lại với bản mới

Không cần tải DMG thủ công cho các bản cập nhật sau!
