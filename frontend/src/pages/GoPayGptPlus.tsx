import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { TaskLogPanel } from "@/components/tasks/TaskLogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, RefreshCw, Sparkles, X } from "lucide-react";

/**
 * GoPay 协议付款 ChatGPT Plus
 * ---------------------------------------------------------------
 * 三步流水线（参考 application/gopay_pay_chatgpt.py）：
 *
 *   ① 协议   generate_plus_link(country=ID, currency=IDR) → cashier_url
 *   ② 浏览器  打开 cashier_url，等用户/自动化跳到 app.midtrans.com → midtrans_url
 *   ③ 协议   GoPayPayment.pay(midtrans_url, gopay_account) 14 步 Midtrans API
 *
 * 该页面只负责选 ChatGPT/GoPay 账号 + 启动后台 task，详细日志在 TaskLogPanel 里
 * 实时滚动；后端跑完后会把 Tài khoản ChatGPT标 subscribed。
 */

type AccountRow = {
  id: number;
  email: string;
  password?: string;
  user_id?: string;
  lifecycle_status?: string;
  display_status?: string;
  plan_state?: string;
  created_at?: string;
  cashier_url?: string;
  overview?: any;
  display_summary?: any;
  extra?: any;
};

function getLifecycleStatus(acc: AccountRow): string {
  return (
    acc.display_summary?.status?.lifecycle ||
    acc.lifecycle_status ||
    "registered"
  );
}

function getPlanState(acc: AccountRow): string {
  return (
    acc.display_summary?.status?.plan_state ||
    acc.plan_state ||
    acc.overview?.plan_state ||
    "unknown"
  );
}

function getBalanceRp(acc: AccountRow): number {
  const candidates = [
    acc.overview?.balance_rp,
    acc.display_summary?.balance_rp,
    acc.extra?.balance_rp,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function getPhone(acc: AccountRow): string {
  return (
    acc.overview?.phone ||
    acc.extra?.phone ||
    acc.email ||
    ""
  );
}

export default function GoPayGptPlus() {
  const [chatgptAccounts, setChatgptAccounts] = useState<AccountRow[]>([]);
  const [gopayAccounts, setGopayAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChatgpt, setSelectedChatgpt] = useState<Set<number>>(new Set());
  const [selectedGopayId, setSelectedGopayId] = useState<number | null>(null);
  const [country, setCountry] = useState("ID");
  const [currency, setCurrency] = useState("IDR");
  const [grabTimeout, setGrabTimeout] = useState(300);
  const [midtransOverride, setMidtransOverride] = useState("");
  // Chế độ trình duyệt（同 CtfGptPlus），bitbrowser_* 需要 profile id
  const [checkoutMode, setCheckoutMode] = useState("camoufox_headed");
  // GoPay 红包链接（余额不足时领红包补余额）
  const [envelopeUrl, setEnvelopeUrl] = useState("");
  // Số luồng đồng thời
  const [concurrency, setConcurrency] = useState(1);
  // 未选 Tài khoản ChatGPT时先Đăng ký的数量
  const [registerCount, setRegisterCount] = useState(1);
  // Nguồn tài khoản GoPay：auto=先池后Đăng ký / pool=只用号池 / register=强制现Đăng ký
  const [gopaySource, setGopaySource] = useState<"auto" | "pool" | "register">(
    "auto",
  );
  // 自动Đăng ký GoPay 号用的 PIN
  const [gopayPin, setGopayPin] = useState("147258");
  // Kênh nhận SMS：herosms / smspool / smsbower
  const [smsProvider, setSmsProvider] = useState("herosms");
  // Giới hạn giá lấy số (USD)。herosms / smspool 都按 USD 计价，默认 0.11。
  // 留空 = 用后端默认值。
  const [maxPrice, setMaxPrice] = useState("0.11");
  // smspool 默认 api key
  const [smspoolApiKey, setSmspoolApiKey] = useState(
    "",
  );
  // smsbower 默认 api key（与 Hero-SMS 同协议，但活跃印尼号源更多）
  const [smsbowerApiKey, setSmsbowerApiKey] = useState(
    "",
  );
  // Hero-SMS API key 不存账号 extra（避免泄漏给前端 overview），付款步骤
  // 必须在每次任务提交时透传。默认填一个常用 key，留空则后端回退环境变量。
  const [herosmsApiKey, setHerosmsApiKey] = useState(
    "",
  );

  const BROWSER_MODE_OPTIONS = [
    { value: "camoufox_headed", label: "Camoufox hiển thị" },
    { value: "camoufox_headless", label: "Camoufox nền" },
    { value: "bitbrowser_headed", label: "BitBrowser hiển thị" },
    { value: "bitbrowser_hidden", label: "BitBrowser ẩn" },
    { value: "bitbrowser_headless", label: "BitBrowser nền" },
  ];
  const [taskId, setTaskId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [chatgptSearch, setChatgptSearch] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      // Tài khoản ChatGPT：只列 plan_state != subscribed 的（已订阅没必要再付一遍）
      const chatgptParams = new URLSearchParams({
        platform: "chatgpt",
        page: "1",
        page_size: "100",
      });
      if (chatgptSearch) chatgptParams.set("email", chatgptSearch);
      const chatgptRes = await apiFetch(`/accounts?${chatgptParams}`);
      setChatgptAccounts(chatgptRes.items || []);

      // GoPay 账号
      const gopayRes = await apiFetch(
        `/accounts?platform=gopay&page=1&page_size=100`,
      );
      setGopayAccounts(gopayRes.items || []);
    } catch (err) {
      console.error("Tải tài khoản thất bại", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(reload, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatgptSearch]);

  const usableGopayAccounts = useMemo(
    () => gopayAccounts.filter((acc) => getBalanceRp(acc) >= 1),
    [gopayAccounts],
  );

  const togglePick = (id: number) => {
    setSelectedChatgpt((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = async () => {
    if (selectedChatgpt.size === 0 && registerCount < 1) {
      alert("Vui lòng chọn ít nhất 1 tài khoản ChatGPT hoặc đặt số lượng đăng ký ≥ 1");
      return;
    }
    if (gopaySource === "pool" && !selectedGopayId) {
      alert("Chế độ “chỉ dùng kho số” cần chọn một tài khoản GoPay bên dưới");
      return;
    }
    setStarting(true);
    try {
      const body: any = {
        chatgpt_account_ids: [...selectedChatgpt],
        gopay_account_id:
          gopaySource === "pool" ? selectedGopayId : 0,
        country,
        currency,
        checkout_mode: checkoutMode,
        envelope_url: envelopeUrl.trim(),
        concurrency,
        grab_timeout: grabTimeout,
        midtrans_url_override: midtransOverride.trim() || "",
        herosms_api_key: herosmsApiKey.trim(),
        gopay_source: gopaySource,
        auto_register_gopay: gopaySource !== "pool",
        gopay_pin: gopayPin.trim() || "147258",
        sms_provider: smsProvider,
        smspool_api_key: smspoolApiKey.trim(),
        smsbower_api_key: smsbowerApiKey.trim(),
        max_price: maxPrice.trim(),
      };
      // 未选 Tài khoản ChatGPT → 从Đăng kýBắt đầu
      if (selectedChatgpt.size === 0) {
        body.register_count = registerCount;
      }
      console.log("[gopay-pay-chatgpt] submit payload:", body);
      const res = await apiFetch("/tasks/gopay-pay-chatgpt", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTaskId(res.task_id);
    } catch (err: any) {
      alert(`Khởi động tác vụ thất bại: ${err?.message || err}`);
    } finally {
      setStarting(false);
    }
  };

  const closeTask = () => {
    setTaskId(null);
    reload();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <Card className="shrink-0 bg-[var(--bg-pane)]/40 border border-[var(--border)] shadow-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]/50">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[var(--accent)]" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              GoPay tạo GPT Plus
            </h1>
            <Badge variant="secondary" className="ml-2">
              Thanh toán GPT Plus qua giao thức GoPay Indonesia
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={reload}
              disabled={loading}
              className="h-8"
            >
              {loading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Làm mới
            </Button>
            <Button
              size="sm"
              onClick={start}
              disabled={starting || (selectedChatgpt.size === 0 && registerCount < 1)}
              className="h-8 shadow-sm"
            >
              {starting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              Bắt đầu ({selectedChatgpt.size > 0 ? selectedChatgpt.size : `Đăng ký ${registerCount}`})
            </Button>
          </div>
        </div>
        <div className="px-5 py-3 text-xs text-[var(--text-muted)] grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block mb-1">Chế độ trình duyệt</label>
            <select
              value={checkoutMode}
              onChange={(e) => setCheckoutMode(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              {BROWSER_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-1">Quốc gia</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="ID">Indonesia (ID)</option>
              <option value="US">Hoa Kỳ (US)</option>
            </select>
          </div>
          <div>
            <label className="block mb-1">Tiền tệ</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="IDR">IDR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div>
            <label className="block mb-1">Số luồng đồng thời</label>
            <input
              type="number"
              min={1}
              max={5}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="control-surface control-surface-compact w-full text-center"
            />
          </div>
          <div>
            <label className="block mb-1">Timeout lấy URL bằng trình duyệt (giây)</label>
            <input
              type="number"
              min={60}
              value={grabTimeout}
              onChange={(e) => setGrabTimeout(Number(e.target.value))}
              className="control-surface control-surface-compact w-full"
            />
          </div>
          {checkoutMode.startsWith("bitbrowser") && (
            <div className="md:col-span-2 flex items-end">
              <p className="text-[11px] text-[var(--text-muted)] leading-tight">
                Chế độ BitBrowser tự lấy profile theo số luồng từ kho “Cài đặt → BitBrowser”; mỗi luồng dùng riêng một profile, không cần nhập ID thủ công.
              </p>
            </div>
          )}
          {selectedChatgpt.size === 0 && (
            <div>
              <label className="block mb-1">Số lượng đăng ký ChatGPT (khi chưa chọn tài khoản)</label>
              <input
                type="number"
                min={1}
                max={50}
                value={registerCount}
                onChange={(e) => setRegisterCount(Number(e.target.value))}
                className="control-surface control-surface-compact w-full text-center"
              />
            </div>
          )}
        </div>
        <div className="px-5 pb-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              Midtrans URL trực tiếp (tùy chọn, bỏ qua bước trình duyệt lấy URL)
            </label>
            <input
              type="text"
              value={midtransOverride}
              onChange={(e) => setMidtransOverride(e.target.value)}
              placeholder="https://app.midtrans.com/snap/v4/redirection/..."
              className="control-surface control-surface-compact w-full"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block mb-1 text-[var(--text-muted)]">
              Liên kết phong bì GoPay (tùy chọn, nhận thêm số dư khi thiếu)
            </label>
            <input
              type="text"
              value={envelopeUrl}
              onChange={(e) => setEnvelopeUrl(e.target.value)}
              placeholder="https://app.gopay.co.id/NF8p/qps2s1y0"
              className="control-surface control-surface-compact w-full"
            />
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              Nguồn tài khoản GoPay
            </label>
            <select
              value={gopaySource}
              onChange={(e) =>
                setGopaySource(e.target.value as "auto" | "pool" | "register")
              }
              className="control-surface control-surface-compact w-full"
            >
              <option value="auto">Tự động (ưu tiên kho số, hết thì đăng ký mới)</option>
              <option value="pool">Chỉ dùng kho số (hết số thì thất bại)</option>
              <option value="register">Bắt buộc đăng ký tài khoản mới (bỏ qua kho số)</option>
            </select>
            <div className="mt-1 text-xs font-mono text-[var(--accent)]">
              Đang chọn = {gopaySource}
            </div>
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              PIN GoPay tự đăng ký (6 chữ số)
            </label>
            <input
              type="text"
              maxLength={6}
              value={gopayPin}
              onChange={(e) => setGopayPin(e.target.value.replace(/\D/g, ""))}
              placeholder="147258"
              className="control-surface control-surface-compact w-full text-center font-mono"
            />
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">Kênh nhận SMS</label>
            <select
              value={smsProvider}
              onChange={(e) => setSmsProvider(e.target.value)}
              className="control-surface control-surface-compact w-full"
            >
              <option value="herosms">Hero-SMS</option>
              <option value="smspool">SMSPool</option>
              <option value="smsbower">SMSBower</option>
            </select>
          </div>
          <div>
            <label className="block mb-1 text-[var(--text-muted)]">
              Giới hạn giá lấy số (USD)
            </label>
            <input
              type="text"
              value={maxPrice}
              onChange={(e) =>
                setMaxPrice(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="0.11"
              className="control-surface control-surface-compact w-full text-center font-mono"
            />
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              Hero-SMS / SMSPool đều tính theo USD. Để trống hoặc 0 = không giới hạn giá.
            </div>
          </div>
          {smsProvider === "smspool" && (
            <div>
              <label className="block mb-1 text-[var(--text-muted)]">
                SMSPool API Key
              </label>
              <input
                type="password"
                value={smspoolApiKey}
                onChange={(e) => setSmspoolApiKey(e.target.value)}
                placeholder="SMSPool API key"
                className="control-surface control-surface-compact w-full"
              />
            </div>
          )}
          {smsProvider === "smsbower" && (
            <div>
              <label className="block mb-1 text-[var(--text-muted)]">
                SMSBower API Key
              </label>
              <input
                type="password"
                value={smsbowerApiKey}
                onChange={(e) => setSmsbowerApiKey(e.target.value)}
                placeholder="SMSBower API key"
                className="control-surface control-surface-compact w-full"
              />
            </div>
          )}
          <div className="md:col-span-2">
            <label className="block mb-1 text-[var(--text-muted)]">
              Hero-SMS API key（dùng cho OTP thanh toán; để trống thì backend dùng biến môi trường OPAI_HEROSMS_API_KEY）
            </label>
            <input
              type="password"
              value={herosmsApiKey}
              onChange={(e) => setHerosmsApiKey(e.target.value)}
              placeholder="API key nền tảng nhận SMS herosms"
              className="control-surface control-surface-compact w-full"
            />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0 overflow-hidden">
        {/* ChatGPT account list */}
        <Card className="flex flex-col min-h-0 bg-[var(--bg-pane)]/40 border border-[var(--border)]">
          <div className="px-4 py-3 border-b border-[var(--border)]/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                Tài khoản ChatGPT
              </span>
              <Badge variant="secondary">Đã chọn {selectedChatgpt.size}</Badge>
            </div>
            <input
              type="text"
              value={chatgptSearch}
              onChange={(e) => setChatgptSearch(e.target.value)}
              placeholder="Tìm email"
              className="control-surface control-surface-compact"
              style={{ width: 200 }}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="text-left text-[var(--text-muted)]">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Gói</th>
                  <th className="px-3 py-2">cashier_url</th>
                </tr>
              </thead>
              <tbody>
                {chatgptAccounts.map((acc) => {
                  const checked = selectedChatgpt.has(acc.id);
                  const planState = getPlanState(acc);
                  const isSubscribed = planState === "subscribed";
                  const lifecycleStatus = getLifecycleStatus(acc);
                  const cashier = acc.cashier_url || acc.overview?.cashier_url || "";
                  return (
                    <tr
                      key={acc.id}
                      className={`hover:bg-[var(--bg-hover)] ${
                        isSubscribed ? "opacity-60" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePick(acc.id)}
                          className="h-4 w-4 accent-[var(--accent)]"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)]">
                        {acc.email}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge
                          variant={
                            isSubscribed
                              ? "success"
                              : lifecycleStatus === "invalid"
                                ? "danger"
                                : "secondary"
                          }
                        >
                          {planState}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-muted)] truncate max-w-[200px]">
                        {cashier ? "✓" : "-"}
                      </td>
                    </tr>
                  );
                })}
                {chatgptAccounts.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-[var(--text-muted)]"
                    >
                      Chưa có tài khoản ChatGPT
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* GoPay account list */}
        <Card className="flex flex-col min-h-0 bg-[var(--bg-pane)]/40 border border-[var(--border)]">
          <div className="px-4 py-3 border-b border-[var(--border)]/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                Tài khoản GoPay (số dư ≥ 1 IDR mới dùng được)
              </span>
              <Badge variant="secondary">
                Dùng được {usableGopayAccounts.length}/{gopayAccounts.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              {gopaySource === "pool"
                ? "Chọn một tài khoản bên dưới để thanh toán"
                : gopaySource === "register"
                  ? "Bắt buộc đăng ký tài khoản mới (bỏ qua kho bên dưới)"
                  : "Tự động chọn (ưu tiên kho số, hết thì đăng ký mới)"}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--bg-card)]">
                <tr className="text-left text-[var(--text-muted)]">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Số điện thoại</th>
                  <th className="px-3 py-2">Số dư (IDR)</th>
                  <th className="px-3 py-2">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {gopayAccounts.map((acc) => {
                  const balance = getBalanceRp(acc);
                  const usable = balance >= 1;
                  const phone = getPhone(acc);
                  const lifecycleStatus = getLifecycleStatus(acc);
                  const selected =
                    gopaySource === "pool" && selectedGopayId === acc.id;
                  return (
                    <tr
                      key={acc.id}
                      className={`hover:bg-[var(--bg-hover)] ${
                        !usable ? "opacity-50" : ""
                      } ${selected ? "bg-[var(--accent-soft)]" : ""}`}
                      onClick={() => {
                        if (gopaySource === "pool" && usable) {
                          setSelectedGopayId(acc.id);
                        }
                      }}
                    >
                      <td className="px-3 py-1.5">
                        {gopaySource === "pool" ? (
                          <input
                            type="radio"
                            checked={selected}
                            onChange={() => setSelectedGopayId(acc.id)}
                            disabled={!usable}
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)] font-mono">
                        {phone}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--text-primary)] font-mono">
                        {balance.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge
                          variant={
                            usable
                              ? "success"
                              : lifecycleStatus === "invalid"
                                ? "danger"
                                : "secondary"
                          }
                        >
                          {usable ? "Dùng được" : "Không đủ số dư"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
                {gopayAccounts.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-[var(--text-muted)]"
                    >
                      Chưa có tài khoản GoPay, hãy vào “Tài khoản / GoPay” để đăng ký
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Task execution log modal */}
      {taskId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => e.target === e.currentTarget && closeTask()}
        >
          <div
            className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col w-[800px] max-w-[95vw]"
            style={{ maxHeight: "85vh" }}
          >
            <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Log thực thi thanh toán giao thức GoPay
              </h3>
              <button
                onClick={closeTask}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              <TaskLogPanel taskId={taskId} onDone={() => reload()} />
            </div>
            <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end">
              <Button variant="outline" size="sm" onClick={closeTask}>
                Đóng
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
