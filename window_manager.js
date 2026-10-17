/**
 * Window Manager for Floating UI
 * Handles dragging, resizing, z-indexing, minimizing, maximizing, and closing floating windows.
 */

class FloatingWindowManager {
  constructor() {
    this.windows = [];
    this.highestZIndex = 1000;
    this.dockContainer = null;
    this.mobileTabbar = null;
    this.mobileActive = null;
    this.initDock();
    this.initMobileMode();
  }

  initDock() {
    this.dockContainer = document.createElement("div");
    this.dockContainer.className = "window-dock";
    document.body.appendChild(this.dockContainer);
  }

  // ── Mobile mode ─────────────────────────────────────────────────────────
  // Below 820px the floating windows become full-area sheets switched by a
  // bottom tab bar instead of free-floating draggable frames.
  initMobileMode() {
    const mql = window.matchMedia("(max-width: 820px)");
    this.mobileMql = mql;
    const apply = () => this.applyMobileMode();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(apply);
    }
    window.addEventListener("resize", () => {
      if (this.isMobile()) this.updateWsTopVar();
    });
    window.addEventListener("orientationchange", () => {
      setTimeout(() => {
        if (this.isMobile()) this.updateWsTopVar();
      }, 300);
    });
    this.applyMobileMode();
  }

  isMobile() {
    return document.body.classList.contains("cop-mobile");
  }

  updateWsTopVar() {
    const top =
      typeof window.copWorkspaceTop === "function" ? window.copWorkspaceTop() : 60;
    document.documentElement.style.setProperty("--cop-ws-top", top + "px");
  }

  ensureMobileTabbar() {
    if (this.mobileTabbar && document.body.contains(this.mobileTabbar)) {
      return this.mobileTabbar;
    }
    const bar = document.createElement("div");
    bar.className = "mobile-tabbar";
    bar.setAttribute("role", "tablist");
    document.body.appendChild(bar);
    this.mobileTabbar = bar;
    return bar;
  }

  registerMobileWindow(win, title) {
    if (win.__mobileTabBtn && document.body.contains(win.__mobileTabBtn)) return;
    const bar = this.ensureMobileTabbar();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mobile-tab-btn";
    btn.textContent = title || "Fenêtre";
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => this.activateMobileWindow(win));
    bar.appendChild(btn);
    win.__mobileTabBtn = btn;
  }

  // app.js opens windows by setting style.display directly (workspace
  // restore, toggleBenchmarkPanel, …). On phone layout, route those open
  // requests through the tab bar so the target becomes the active sheet
  // instead of stacking over the currently visible one.
  watchMobileDisplay(win) {
    if (win.__mobileDisplayObserver) return;
    win.__mobileDisplayObserver = new MutationObserver(() => {
      if (!this.isMobile() || !win.classList.contains("cop-mobile-area")) return;
      const disp = win.style.display;
      if ((disp === "flex" || disp === "block") && !win.classList.contains("cop-mobile-active")) {
        win.style.display = "";
        this.activateMobileWindow(win);
      }
    });
    win.__mobileDisplayObserver.observe(win, { attributes: true, attributeFilter: ["style"] });
  }

  enterMobileLayout(win) {
    if (!win || win.classList.contains("cop-mobile-area")) return;
    // Keep desktop geometry so leaving mobile mode can restore the layout.
    win.dataset.mobPrevLeft = win.style.left || "";
    win.dataset.mobPrevTop = win.style.top || "";
    win.dataset.mobPrevWidth = win.style.width || "";
    win.dataset.mobPrevHeight = win.style.height || "";
    win.classList.add("cop-mobile-area");
    const reg = this.windows.find((w) => w.element === win);
    this.registerMobileWindow(win, reg ? reg.originalTitle : "Fenêtre");
    this.watchMobileDisplay(win);
  }

  exitMobileLayoutAll() {
    this.mobileActive = null;
    for (const w of this.windows) {
      const win = w.element;
      if (!win.classList.contains("cop-mobile-area")) continue;
      win.classList.remove("cop-mobile-area", "cop-mobile-active");
      if (win.__mobileTabBtn) {
        win.__mobileTabBtn.classList.remove("mobile-tab-active");
      }
      if (win.dataset.mobPrevWidth) {
        win.style.left = win.dataset.mobPrevLeft || "50px";
        win.style.top = win.dataset.mobPrevTop || "50px";
        win.style.width = win.dataset.mobPrevWidth || "400px";
        win.style.height = win.dataset.mobPrevHeight || "300px";
      } else {
        // Window was created while already in mobile mode: use sane desktop
        // defaults matching the DOMContentLoaded layout.
        const top = (typeof window.copWorkspaceTop === "function") ? window.copWorkspaceTop() : 60;
        const defaults = {
          "win-logs-sidebar": { left: 10, top: top + 10, width: 280, height: window.innerHeight - 120 },
          "win-map": { left: 300, top: top + 10, width: Math.max(320, window.innerWidth - 650), height: window.innerHeight - 150 },
          "win-smartcare-sidebar": { left: Math.max(10, window.innerWidth - 320), top: top + 10, width: 300, height: window.innerHeight - 120 },
          "win-benchmarkPanel": { left: Math.max(8, Math.round((window.innerWidth - Math.min(1180, Math.round(window.innerWidth * 0.92))) / 2)), top: Math.max(top, Math.round((window.innerHeight - Math.min(840, Math.round(window.innerHeight * 0.9))) / 2)), width: Math.min(1180, Math.round(window.innerWidth * 0.92)), height: Math.min(840, Math.round(window.innerHeight * 0.9)) },
        };
        const def = defaults[win.id] || { left: 50, top: top + 10, width: 420, height: 320 };
        win.style.left = def.left + "px";
        win.style.top = def.top + "px";
        win.style.width = def.width + "px";
        win.style.height = def.height + "px";
      }
    }
    if (this.mobileTabbar) {
      this.mobileTabbar.remove();
      this.mobileTabbar = null;
    }
    this.invalidateLeafletIfContained();
  }

  activateMobileWindow(win) {
    if (!win) return;
    this.mobileActive = win;
    for (const w of this.windows) {
      const active = w.element === win;
      w.element.classList.toggle("cop-mobile-active", active);
      if (w.element.__mobileTabBtn) {
        w.element.__mobileTabBtn.classList.toggle("mobile-tab-active", active);
      }
      if (active && w.element.style.display === "none") {
        w.element.style.display = "flex";
      }
    }
    this.bringToFront(win);
    this.updateWsTopVar();
    this.invalidateLeafletIfContained(win);
    window.dispatchEvent(new Event("resize"));
  }

  invalidateLeafletIfContained(win) {
    setTimeout(() => {
      const leafletMap =
        window.mapRenderer && window.mapRenderer.map
          ? window.mapRenderer.map
          : window.map || null;
      if (
        leafletMap &&
        typeof leafletMap.invalidateSize === "function" &&
        (!win || (win.contains && win.contains(leafletMap.getContainer())))
      ) {
        leafletMap.invalidateSize();
      }
    }, 60);
  }

  applyMobileMode() {
    const mobile = !!(this.mobileMql && this.mobileMql.matches);
    if (mobile && !this.isMobile()) {
      document.body.classList.add("cop-mobile");
      this.ensureMobileTabbar();
      this.updateWsTopVar();
      // Header height settles after the CSS class application (wrap/labels).
      setTimeout(() => this.updateWsTopVar(), 250);
      for (const w of this.windows) this.enterMobileLayout(w.element);
      const mapWin = this.windows.find((w) => w.element.id === "win-map");
      if (!this.mobileActive && mapWin) {
        this.activateMobileWindow(mapWin.element);
      }
    } else if (mobile && this.isMobile()) {
      this.updateWsTopVar();
      setTimeout(() => this.updateWsTopVar(), 250);
      if (!this.mobileActive) {
        const mapWin = this.windows.find((w) => w.element.id === "win-map");
        if (mapWin) this.activateMobileWindow(mapWin.element);
      }
    } else if (!mobile && this.isMobile()) {
      document.body.classList.remove("cop-mobile");
      this.exitMobileLayoutAll();
    }
  }

  bringToFront(winElement) {
    if (parseInt(winElement.style.zIndex, 10) === this.highestZIndex) return;
    this.highestZIndex++;
    winElement.style.zIndex = this.highestZIndex;
  }

  makeFloating(element, title, options = {}) {
    // Wrap element in floating window container
    const win = document.createElement("div");
    win.className = "floating-window";
    win.id = "win-" + (element.id || Math.random().toString(36).substr(2, 9));

    // Initial positioning
    win.style.left = options.x !== undefined ? options.x + "px" : "50px";
    win.style.top = options.y !== undefined ? options.y + "px" : "50px";
    win.style.width =
      options.width !== undefined ? options.width + "px" : "400px";
    win.style.height =
      options.height !== undefined ? options.height + "px" : "300px";

    if (options.maximize) {
      win.classList.add("maximized");
      win.style.left = "0";
      win.style.top = "0";
      win.style.width = "100%";
      win.style.height = "100%";
    }

    // Header
    const header = document.createElement("div");
    header.className = "window-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "window-title";
    titleSpan.textContent = title;
    header.appendChild(titleSpan);

    const controls = document.createElement("div");
    controls.className = "window-controls";

    const minBtn = document.createElement("button");
    minBtn.innerHTML = "&#8211;"; // en-dash
    minBtn.className = "win-btn min-btn";
    minBtn.title = "Minimize";

    const maxBtn = document.createElement("button");
    maxBtn.innerHTML = "&#9633;"; // square
    maxBtn.className = "win-btn max-btn";
    maxBtn.title = "Maximize";

    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.className = "win-btn close-btn";
    closeBtn.title = "Close";

    controls.appendChild(minBtn);
    controls.appendChild(maxBtn);
    controls.appendChild(closeBtn);
    header.appendChild(controls);
    win.appendChild(header);

    // Content container
    const content = document.createElement("div");
    content.className = "window-content";

    // Move the original element into the content
    // If element is already in the DOM, replace it
    if (element.parentNode) {
      element.parentNode.insertBefore(win, element);
    } else {
      document.querySelector("main").appendChild(win);
    }
    content.appendChild(element);
    // We don't force element.style.display = 'block', let CSS or app.js handle inner visibility
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.boxSizing = "border-box";
    win.appendChild(content);

    // Add Resize Handles
    const directions = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
    directions.forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = `window-resize-handle resize-${dir}`;
      handle.dataset.dir = dir;
      win.appendChild(handle);
    });

    // Watch for internal element display changes to automatically show the window
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.attributeName === "class" &&
          element.classList.contains("is-open")
        ) {
          if (win.style.display === "none") {
            if (this.isMobile() && !win.classList.contains("cop-mobile-active")) return;
            win.style.display = "flex";
            this.bringToFront(win);
          }
        } else if (mutation.attributeName === "style") {
          const elDisp = element.style.display;
          if (
            (elDisp === "flex" || elDisp === "block") &&
            win.style.display === "none"
          ) {
            if (this.isMobile() && !win.classList.contains("cop-mobile-active")) return;
            win.style.display = "flex";
            this.bringToFront(win);
          }
        }
      });
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    this.setupDragging(win, header);
    this.setupResizing(win);
    this.setupControls(win, element, title, minBtn, maxBtn, closeBtn);

    win.addEventListener("mousedown", () => this.bringToFront(win), {
      capture: true,
    });
    this.bringToFront(win);

    this.windows.push({
      id: win.id,
      element: win,
      content: element,
      originalTitle: title,
    });

    if (options.hidden) {
      win.style.display = "none";
    } else if (this.isMobile()) {
      // Windows created while the phone layout is active join the tab bar.
      this.enterMobileLayout(win);
    }

    // Setup Resize Observer to invalidate maps or charts
    const ro = new ResizeObserver(() => {
      const leafletMap =
        window.mapRenderer && window.mapRenderer.map
          ? window.mapRenderer.map
          : window.map || null;
      if (leafletMap && element.contains(leafletMap.getContainer())) {
        leafletMap.invalidateSize();
      }
      // Trigger a general window resize event for charts
      window.dispatchEvent(new Event("resize"));
    });
    ro.observe(content);

    return win;
  }

  setupDragging(win, header) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const onPointerDown = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest(".window-controls")) return;
      if (win.classList.contains("maximized")) return;
      // Phone layout uses full-area sheets: dragging is disabled.
      if (this.isMobile() && win.classList.contains("cop-mobile-area")) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = parseInt(win.style.left || 0, 10);
      initialTop = parseInt(win.style.top || 0, 10);

      try { header.setPointerCapture(e.pointerId); } catch (_) {}
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newL = initialLeft + dx;
      let newT = initialTop + dy;

      const winW = win.offsetWidth;
      const winH = win.offsetHeight;

      const parentW = win.offsetParent ? win.offsetParent.clientWidth : window.innerWidth;
      const parentH = win.offsetParent ? win.offsetParent.clientHeight : window.innerHeight;

      // Clamp to bounds — never above the app header bottom.
      const topLimit = (typeof window.copWorkspaceTop === "function") ? window.copWorkspaceTop() : 0;
      if (newL < 0) newL = 0;
      if (newT < topLimit) newT = topLimit;
      if (newL + winW > parentW)
        newL = Math.max(0, parentW - winW);
      if (newT + winH > parentH)
        newT = Math.max(topLimit, parentH - winH);

      win.style.left = newL + "px";
      win.style.top = newT + "px";
    };

    const onPointerUp = () => {
      isDragging = false;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };

    header.addEventListener("pointerdown", onPointerDown);
  }

  setupResizing(win) {
    let isResizing = false;
    let startX, startY, startW, startH, startL, startT;
    let currentDir = "";

    const onPointerDown = (handle) => (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (win.classList.contains("maximized")) return;
      // Phone layout: fixed full-area sheets, no resize.
      if (this.isMobile() && win.classList.contains("cop-mobile-area")) return;

      isResizing = true;
      currentDir = handle.dataset.dir;
      startX = e.clientX;
      startY = e.clientY;
      startW = parseInt(document.defaultView.getComputedStyle(win).width, 10);
      startH = parseInt(
        document.defaultView.getComputedStyle(win).height,
        10,
      );
      startL = parseInt(win.style.left || 0, 10);
      startT = parseInt(win.style.top || 0, 10);

      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newW = startW;
      let newH = startH;
      let newL = startL;
      let newT = startT;

      if (currentDir.includes("e")) newW = startW + dx;
      if (currentDir.includes("s")) newH = startH + dy;
      if (currentDir.includes("w")) {
        newW = startW - dx;
        newL = startL + dx;
      }
      if (currentDir.includes("n")) {
        newH = startH - dy;
        newT = startT + dy;
      }

      // Min size constraints
      if (newW < 200) {
        if (currentDir.includes("w")) newL -= 200 - newW;
        newW = 200;
      }
      if (newH < 100) {
        if (currentDir.includes("n")) newT -= 100 - newH;
        newH = 100;
      }

      const parentW = win.offsetParent ? win.offsetParent.clientWidth : window.innerWidth;
      const parentH = win.offsetParent ? win.offsetParent.clientHeight : window.innerHeight;

      // Clamp to bounds — north edge never above the app header bottom.
      const topLimit = (typeof window.copWorkspaceTop === "function") ? window.copWorkspaceTop() : 0;
      if (newL < 0) {
        newW += newL;
        newL = 0;
      }
      if (newT < topLimit) {
        newH += (newT - topLimit);
        newT = topLimit;
      }
      if (newL + newW > parentW) {
        newW = parentW - newL;
      }
      if (newT + newH > parentH) {
        newH = parentH - newT;
      }

      win.style.width = newW + "px";
      win.style.height = newH + "px";
      win.style.left = newL + "px";
      win.style.top = newT + "px";
    };

    const onPointerUp = () => {
      isResizing = false;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };

    const handles = win.querySelectorAll(".window-resize-handle");
    handles.forEach((handle) => {
      handle.addEventListener("pointerdown", onPointerDown(handle));
    });
  }

  setupControls(win, element, title, minBtn, maxBtn, closeBtn) {
    // Maximize
    maxBtn.addEventListener("click", () => {
      if (win.classList.contains("maximized")) {
        win.classList.remove("maximized");
        win.style.left = win.dataset.prevLeft;
        win.style.top = win.dataset.prevTop;
        win.style.width = win.dataset.prevWidth;
        win.style.height = win.dataset.prevHeight;
      } else {
        win.dataset.prevLeft = win.style.left;
        win.dataset.prevTop = win.style.top;
        win.dataset.prevWidth = win.style.width;
        win.dataset.prevHeight = win.style.height;
        win.classList.add("maximized");
        // Maximized fills the workspace below the app header, never over it.
        const maxTop = (typeof window.copWorkspaceTop === "function") ? window.copWorkspaceTop() : 0;
        win.style.left = "0px";
        win.style.top = maxTop + "px";
        win.style.width = "100%";
        win.style.height = "calc(100% - " + maxTop + "px)";
      }
    });

    // Minimize
    minBtn.addEventListener("click", () => {
      win.style.display = "none";
      this.createDockItem(win, title);
    });

    // Close
    closeBtn.addEventListener("click", () => {
      win.style.display = "none";
      if (element.classList && element.classList.contains("is-open")) {
        element.classList.remove("is-open");
      }
    });
  }

  createDockItem(win, title) {
    const item = document.createElement("div");
    item.className = "dock-item";
    item.textContent = title;
    item.onclick = () => {
      win.style.display = "flex";
      this.bringToFront(win);
      win.classList.remove("minimized");
      item.remove();
    };
    item.__winRef = win;
    this.dockContainer.appendChild(item);
  }
}

// Workspace top limit: no floating window may be dragged, resized or
// maximized above the bottom of the app header (#mainHeader).
window.copWorkspaceTop = function () {
  try {
    const h = document.getElementById("mainHeader");
    if (h) {
      const r = h.getBoundingClientRect();
      if (r && Number.isFinite(r.bottom) && r.bottom > 0) return Math.round(r.bottom);
    }
  } catch (e) {}
  return 60;
};

// Global instance
window.WM = new FloatingWindowManager();

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    // Viewport-anchored windows: common top origin below the app header
    // so Logs / Map / DT Layers always align.
    const headerEl = document.getElementById("mainHeader");
    const topLimitNum = headerEl ? Math.round(headerEl.getBoundingClientRect().height) : 60;
    const topOrigin = (topLimitNum + 10) + "px";
    try {
      const sidebar = document.getElementById("logs-sidebar");
      if (sidebar) {
        // Remove existing resize handle since we have our own now
        const resizer = sidebar.querySelector(".sidebar-resizer");
        if (resizer) resizer.remove();

        const leftWin = window.WM.makeFloating(sidebar, "Logs & Data", {
          x: 10,
          y: 10,
          width: 280,
          height: window.innerHeight - 120,
        });
        // Viewport-anchored so all three windows share the same top origin.
        if (leftWin) { leftWin.style.position = "fixed"; leftWin.style.top = topOrigin; }
      }
    } catch (err) { console.warn("[WM] left sidebar floating failed:", err); }

    try {
      const mapContainer = document.getElementById("map");
      if (mapContainer) {
        const mapWin = window.WM.makeFloating(mapContainer, "Map View", {
          x: 300,
          y: 10,
          width: window.innerWidth - 650,
          height: window.innerHeight - 150,
        });
        if (mapWin) { mapWin.style.position = "fixed"; mapWin.style.top = topOrigin; }
        mapContainer.style.height = "100%";
      }
    } catch (err) { console.warn("[WM] map floating failed:", err); }

    try {
      const rightSidebar = document.getElementById("smartcare-sidebar");
      if (rightSidebar) {
        // Remove old resize handle and header
        const resizer = rightSidebar.querySelector(".sidebar-resizer");
        if (resizer) resizer.remove();

        const oldHeader = document.getElementById("smartcareFloatingHeader");
        if (oldHeader) oldHeader.remove();

        // Remove fixed positioning from css by overriding inline
        rightSidebar.style.position = "static";
        rightSidebar.style.height = "100%";

        const rightWin = window.WM.makeFloating(rightSidebar, "DT Layers", {
          x: window.innerWidth - 320,
          y: 10,
          width: 300,
          height: window.innerHeight - 120,
        });
        if (rightWin) { rightWin.style.position = "fixed"; rightWin.style.top = topOrigin; }
      }
    } catch (err) { console.warn("[WM] right sidebar floating failed:", err); }

    try {
      const benchmarkPanel = document.getElementById("benchmarkPanel");
      if (benchmarkPanel) {
      // Remove old resize handles and header controls
      const oldHandles = benchmarkPanel.querySelectorAll(
        ".benchmark-resize-handle",
      );
      oldHandles.forEach((h) => h.remove());

      const oldControls = benchmarkPanel.querySelectorAll(
        ".benchmark-minimize-btn, .benchmark-close-btn",
      );
      oldControls.forEach((c) => c.remove());

      // Hide old titles since we have a window header now
      const oldTitles = benchmarkPanel.querySelectorAll(
        "#benchmarkPanelHeader h3, #benchmarkPanelHeader p",
      );
      oldTitles.forEach((t) => (t.style.display = "none"));

      const benchmarkWidth = Math.min(1180, Math.round(window.innerWidth * 0.92));
      const benchmarkHeight = Math.min(840, Math.round(window.innerHeight * 0.9));
      const benchmarkWindow = window.WM.makeFloating(
        benchmarkPanel,
        "5G Benchmark Analysis",
        {
          x: Math.max(8, Math.round((window.innerWidth - benchmarkWidth) / 2)),
          y: Math.max(topLimitNum, Math.round((window.innerHeight - benchmarkHeight) / 2)),
          width: benchmarkWidth,
          height: benchmarkHeight,
          hidden: true,
        },
      );

      if (benchmarkWindow) {
        const raisedZ = Math.max(window.WM.highestZIndex + 1, 1605);
        benchmarkWindow.style.zIndex = String(raisedZ);
        window.WM.highestZIndex = raisedZ;
      }

      benchmarkPanel.style.position = "static";
      benchmarkPanel.style.height = "100%";
      benchmarkPanel.style.minHeight = "0";
      benchmarkPanel.style.flexDirection = "column";

      const benchmarkBody = benchmarkPanel.querySelector(".benchmark-panel-body");
      if (benchmarkBody) {
        benchmarkBody.style.flex = "1 1 auto";
        benchmarkBody.style.minHeight = "0";
        benchmarkBody.style.overflowY = "auto";
      }
      }
    } catch (err) { console.warn("[WM] benchmark window failed:", err); }

    // All windows exist now: (re)apply the phone layout and activate the map
    // tab by default on small screens.
    window.WM.applyMobileMode();
    if (window.WM.isMobile()) {
      setTimeout(() => window.WM.updateWsTopVar(), 400);
    }
  }, 100); // Slight delay to ensure app.js initialized the elements if needed
});
