// 表格欄寬可拖動 + 記憶(localStorage)。兩種佈局共用:
//   layout:"grid"  → 觸發任務表(tr 是 CSS grid),欄寬 = table 上的 CSS 變數 --rz-cols
//   layout:"table" → 傳統 <table>,欄寬 = 注入的 <colgroup> 各 <col> 寬 + table-layout:fixed
//
// 為什麼欄寬掛在「table」而不是 row:dashboard 每 1.5s 輪詢會重建 <tbody> innerHTML。
// 欄寬狀態放在 table 元素上(CSS 變數繼承 / colgroup 是 table 直屬子節點),重建的新 row 自動套用,
// 零額外成本;localStorage 只在「拖完放開」寫一次、「載入」讀一次,輪詢期間完全不碰。
//
// 預設 vs 鎖寬:沒有記憶時**不鎖 px**,保留 HTML/CSS 原本的響應式欄寬(grid 的 %/fr、table 的 auto);
// 使用者真的拖動的當下才量測目前實際欄寬為起點、鎖成 px。這樣預設會隨視窗填滿,不受載入時機/面板寬影響。
// 雙擊把手 = 清記憶、還原成響應式預設。
//
// 欄寬模型:相鄰欄互償——拖第 i 欄右邊界,delta 加到第 i 欄、從第 i+1 欄等量扣除(各受 min 限制),
// 總寬守恒 → 表格永遠填滿容器,不產生橫向捲軸。
(function () {
  function loadWidths(key, n) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && x > 0) ? v : null;
    } catch (_) { return null; }
  }
  function saveWidths(key, widths) {
    try { localStorage.setItem(key, JSON.stringify(widths.map((w) => Math.round(w)))); } catch (_) {}
  }

  function makeResizable(table, opts) {
    opts = opts || {};
    const key = opts.key;
    const layout = opts.layout || "table";
    const thead = table.tHead || table.querySelector("thead");
    const headRow = thead && thead.rows[0];
    if (!headRow) return;
    const ths = Array.from(headRow.cells);
    const n = ths.length;
    if (n < 2) return;
    const mins = ths.map((_, i) => (opts.mins && opts.mins[i] != null ? opts.mins[i] : 48));

    function ensureColgroup() {
      let cg = table.querySelector("colgroup[data-rz]");
      if (!cg) {
        cg = document.createElement("colgroup");
        cg.setAttribute("data-rz", "1");
        for (let i = 0; i < n; i++) cg.appendChild(document.createElement("col"));
        table.insertBefore(cg, table.firstChild);
        table.style.tableLayout = "fixed";
        table.style.width = "100%";
      }
      return Array.from(cg.children);
    }
    function apply(widths) {
      if (layout === "grid") {
        table.style.setProperty("--rz-cols", widths.map((w) => w + "px").join(" "));
      } else {
        const cols = ensureColgroup();
        widths.forEach((w, i) => { if (cols[i]) cols[i].style.width = w + "px"; });
      }
    }
    // 回響應式預設:移除鎖定的 px(grid 移除變數 → 用 CSS fallback;table 拆 colgroup → 回 auto)。
    function clearApplied() {
      if (layout === "grid") {
        table.style.removeProperty("--rz-cols");
      } else {
        const cg = table.querySelector("colgroup[data-rz]");
        if (cg) cg.remove();
        table.style.tableLayout = "";
        table.style.width = "";
      }
    }
    // 量測目前每欄實際渲染寬(px)——拖動起點,確保等於畫面上看到的寬。
    function measure() { return ths.map((th) => th.getBoundingClientRect().width); }

    // 初始:有記憶才鎖 px;沒有 → 保留響應式預設。
    let widths = loadWidths(key, n);
    if (widths) apply(widths);

    // 拖第 i 欄右邊界:i 與 i+1 互償。
    function startDrag(i, ev) {
      ev.preventDefault();
      ev.stopPropagation();
      widths = measure();  // 以當前實際寬為起點(此刻視窗已穩定)
      apply(widths);       // 先鎖成 px(grid 設變數 / table 切 fixed)
      const startX = ev.clientX;
      const w0 = widths[i], w1 = widths[i + 1];
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      function onMove(e) {
        let dx = e.clientX - startX;
        let a = w0 + dx, b = w1 - dx;
        if (a < mins[i]) { b -= mins[i] - a; a = mins[i]; }
        if (b < mins[i + 1]) { a -= mins[i + 1] - b; b = mins[i + 1]; }
        // 兜底:兩欄總寬小於兩 min 之和(容器過窄)時,上面的夾取會互相把對方推成負數;
        // 夾回各自 min(犧牲總寬守恒),絕不讓欄寬變負。正常寬度下不會走到這。
        a = Math.max(a, mins[i]); b = Math.max(b, mins[i + 1]);
        widths[i] = a; widths[i + 1] = b;
        apply(widths);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        saveWidths(key, widths);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    // 每個非最後欄的表頭右緣加一條拖動把手;雙擊 = 清記憶還原響應式預設。
    ths.forEach((th, i) => {
      if (i >= n - 1) return;
      if (th.querySelector(".rz-handle")) return; // 動態重建後避免重複掛
      th.style.position = "relative";
      const h = document.createElement("div");
      h.className = "rz-handle";
      h.addEventListener("mousedown", (e) => startDrag(i, e));
      h.addEventListener("dblclick", (e) => {
        e.preventDefault(); e.stopPropagation();
        try { localStorage.removeItem(key); } catch (_) {}
        widths = null;
        clearApplied();
      });
      th.appendChild(h);
    });

    // 供動態重建表格後重新套用記憶欄寬(例如試跑結果表)。
    return { reapply: () => { if (widths) apply(widths); } };
  }

  window.makeResizable = makeResizable;
})();
