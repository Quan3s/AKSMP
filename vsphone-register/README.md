# VSPhone Auto-Register

Tool tự động đăng ký tài khoản trên **cloud.vsphone.com** (VSPhone – cloud phone Android).

## Flow tool thực hiện (đúng theo API thật của VSPhone)

| Bước | Việc | API |
|---|---|---|
| 1 | Kiểm tra email đã tồn tại chưa | `GET /api/user/checkEmail` |
| 2 | Bấm **Get code** → mở popup captcha Aliyun → solver tự kéo slider | `POST /api/sms/smsSend` (`smsType=2`) |
| 3 | Tự động đọc mã 6 số trong email (mailbox tạm) | inboxkitten / mail.tm / GuerrillaMail |
| 4 | Điền mã + mật khẩu → **Register and log in** | `POST /api/user/login` (`loginType=0`, `password=md5`) |
| 5 | Lưu `email\|mk` ra file + PostgreSQL | `output/accounts.txt`, bảng `vsphone_accounts` |

> **Về captcha:** VSPhone dùng **slider puzzle của Aliyun** (`SceneId 5jvar3wp`, vùng `sgp`) và bắt buộc có nó mới gửi được mã.
> Tool đã **ghép solver** từ repo `vlolhaha/vmos` (`lib/aliyun-captcha.js`), port sang Playwright:
> - bắt `back.png` / `shadow.png` từ network response (fallback: đọc data URL trong DOM);
> - dựng alpha mask của mảnh ghép, dò vị trí gap trên ảnh nền bằng so sánh sáng/texture;
> - quy đổi toạ độ ảnh → toạ độ slider (có nghịch đảo hàm phi tuyến của Aliyun);
> - kéo chuột theo trajectory giống người (tăng tốc → giảm tốc → micro-adjust);
> - chờ ~6s cho POW/risk engine trước khi kéo, tự refresh và thử lại nếu sai.
>
> Mặc định solver chạy tự động. Nếu solver fail (IP bị risk-score cao, ảnh lạ), popup vẫn mở và bạn có thể **kéo slider thủ công** làm fallback — hoặc chạy `--manual` để tắt solver hoàn toàn.

## Cài đặt

```bash
cd vsphone-register
npm install
npx playwright install chromium            # lần đầu
sudo npx playwright install-deps chromium   # nếu thiếu thư viện hệ thống (Linux)
```

## Chạy

```bash
# tạo 5 tài khoản (mặc định), có bật cửa sổ trình duyệt để kéo slider
npm start -- --count 5

# lưu vào PostgreSQL
npm start -- --count 10 --db --db-url "postgres://user:pass@127.0.0.1:5432/vsphone"

# thử 1 tài khoản
npm start -- --count 1

# chỉ kiểm tra email (không đụng captcha) - dùng để test nhanh
node src/index.js --count 1 --dry-run --headless

# test pipeline ghi file + DB mà không gọi website
node src/index.js --count 3 --simulate --provider inboxkitten --db --db-url "postgres://..."
```

Trong lúc chạy, cửa sổ Chromium sẽ mở ra và tự động:

1. điền email → bấm **Login/Register** → vào màn hình đăng ký
2. bấm **Get code** → popup captcha Aliyun hiện lên
3. solver tự đọc ảnh, dò gap, kéo slider → tool tự đọc mã 6 số từ email, điền mã + mật khẩu, bấm **Register and log in**
4. lưu tài khoản vào `output/` (và PostgreSQL nếu bật `--db`)

### Tham số CLI

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--count N` | `5` | số tài khoản cần tạo |
| `--parallel N` | `1` | mở N cửa sổ song song (mỗi cửa sổ có solver riêng, chạy độc lập) |
| `--delay ms` | `25000` | nghỉ giữa 2 tài khoản |
| `--jitter ms` | `10000` | ngẫu nhiên cộng thêm vào delay |
| `--headless` | off | chạy ẩn (chỉ dùng cho `--dry-run`; captcha nên chạy headed để dễ debug) |
| `--password P` | random 12 ký tự | mật khẩu dùng chung cho mọi tài khoản |
| `--provider P` | `inboxkitten` | `inboxkitten` / `mailtm` / `guerrillamail` / `stdin` |
| `--domain D` | – | domain cụ thể của mail.tm |
| `--ikdomain D` | `inboxkitten.com` | domain dùng cho inboxkitten |
| `--out DIR` | `output` | thư mục lưu kết quả |
| `--db` | off | bật lưu PostgreSQL |
| `--db-url URL` | env `DATABASE_URL` | connection string |
| `--db-table T` | `vsphone_accounts` | tên bảng (tự tạo nếu chưa có) |
| `--manual` | off | tắt solver, tự kéo slider tay |
| `--no-auto-captcha` | off | alias của `--manual` |
| `--pow-delay ms` | `6000` | chờ POW/risk engine trước khi kéo slider |
| `--save-debug` | off | ghi `debug-back-N.png` / `debug-shadow-N.png` mỗi lần giải |
| `--debug` | off | log thêm ảnh captcha bắt được từ network |
| `--captcha-timeout ms` | `300000` | chờ `smsSend` tối đa (auto hoặc thủ công) |
| `--mail-timeout ms` | `180000` | chờ email có mã |
| `--dry-run` | off | chỉ gọi `checkEmail`, không đăng ký |
| `--simulate` | off | không gọi website, chỉ test ghi file + DB |
| `--keep-open` | off | giữ trình duyệt mở khi xong |

Cấu hình chi tiết nằm trong `config.json`.

## Chạy song song (nhiều solver cùng lúc)

```bash
npm start -- --count 20 --parallel 4
```

Mở **4 cửa sổ Chromium**, mỗi cửa sổ có popup slider + solver riêng, chạy hoàn toàn độc lập.
Lưu ý: VSPhone rate-limit theo IP nên tăng `--delay` khi `--parallel` lớn.

## Mailbox (tempmail)

* `inboxkitten` (mặc định): `inboxkitten.com` — không cần đăng ký, tự sinh local part, đọc mail qua
  `GET /api/v1/mail/list?recipient=<local>` + `/getHtml?region=&key=`.
* `mailtm`: hộp thư tạm qua `api.mail.tm`.
* `guerrillamail`: provider dự phòng, dùng khi domain kia bị VSPhone chặn.
* `stdin`: tự nhập mã trong terminal — dùng khi bạn tự tạo email:

```bash
node src/index.js --count 1 --provider stdin
```

Tool tự failover qua các provider trong `config.json` → `mailbox.providers`.

## Output

`output/accounts.txt` – **định dạng `mail|mk`**, mỗi tài khoản 1 dòng:

```
14rhnzfbg5jsrj@inboxkitten.com|iFd8RhH%Uy3H
1rys0by8b19wuj@inboxkitten.com|5Jy8veK#o9pu
```

`output/accounts.csv` – thêm `token`, `userId`, `createdAt`.
`output/accounts.json` – bản đầy đủ.

`token` là JWT của web VSPhone, dùng để gọi API (`Header: Token: <token>`) — ví dụ lấy danh sách cloud phone:

```bash
curl -H "Token: <token>" -H "userId: <userId>" \
  https://api.vsphone.com/vsphone/api/userEquipment/list
```

## PostgreSQL

Bật bằng `--db` + `--db-url` (hoặc đặt env `DATABASE_URL`, hoặc `database.enabled` trong `config.json`).
Bảng tự tạo nếu chưa có, `email` là UNIQUE và insert trùng sẽ UPDATE:

```sql
CREATE TABLE IF NOT EXISTS vsphone_accounts (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  password   TEXT,
  token      TEXT,
  user_id    BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```bash
psql -d vsphone -c "SELECT id,email,password,user_id FROM vsphone_accounts ORDER BY id DESC;"
```

## Rate-limit

VSPhone trả `{"code":1014,"msg":"Your operations are too frequent"}` khi gọi `checkEmail`/`smsSend` dồn quá nhanh.
Tool tự backoff (60s → 120s → 180s, tối đa 5 lần) và báo log `[rate-limit] ...`. Nếu vẫn bị chặn, tăng `--delay`.

## Captcha solver (port từ `vlolhaha/vmos`)

`src/aliyun-captcha.js` là bản port CommonJS + Playwright của `lib/aliyun-captcha.js` trong repo vmos.

| Thành phần | Việc |
|---|---|
| `attachImageCollector(page, buffers)` | bắt response `back.png` / `shadow.png`, lưu buffer + timestamp |
| `waitForCaptchaImages` | chờ ảnh từ network, fallback đọc `data:` URL của `#aliyunCaptcha-img` / `#aliyunCaptcha-puzzle` |
| `analyzePiece` | `sharp` → alpha mask + bbox của mảnh ghép |
| `detectGap` | trượt mask mảnh ghép trên ảnh nền, chấm điểm `(độ sáng trong − ngoài) − 1.2·std − 0.3·saturation` |
| `findSlider` | lấy toạ độ slider, `trackWidth`, `imgWidth`, `puzzleWidth` từ DOM |
| `solveAliyunPuzzle` | chờ POW → tính offset → nghịch đảo hàm phi tuyến Aliyun → replay trajectory → check kết quả → refresh/thử lại |

Hàm phi tuyến Aliyun (`k = trackWidth/12`):

```text
pieceLeft = d * (d + k) / (maxD + k)
→ d = (-k + sqrt(k² + 4·pieceTarget·(maxD + k))) / 2
```

Hàm thuần (mask, gap, trajectory) có test bằng ảnh tổng hợp: `node test/solver.test.js`.

## Lưu ý

* Mỗi lần chạy để lại email/mật khẩu trong `output/` (đã gitignore) — đừng commit lên repo, cũng đừng paste vào chat.
* Mỗi email chỉ nhận được **mã 6 số** và server giới hạn ~10 lần thử sai (`Verification code incorrect, N attempts remaining`).
* Captcha phụ thuộc Aliyun risk engine — IP bị đánh dấu có thể phải thử lại nhiều lần hoặc rơi về kéo tay.

## Test nhanh

```bash
npm test                                            # pickcode + solver geometry
node test/solver.test.js                            # chỉ test solver (ảnh tổng hợp)
node src/index.js --count 1 --dry-run --headless    # test ket noi + mailbox
node src/index.js --count 2 --simulate --provider inboxkitten --db --db-url "postgres://..."  # test file + DB
```
