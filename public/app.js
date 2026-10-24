const socket = io();

// สถานะการเข้าสู่ระบบ (เก็บใน Memory เท่านั้น เพื่อให้เข้าเว็บทุกครั้งต้อง Login ใหม่เสมอ)
let authToken = null;
let currentUser = null;

let historyChart = null;
let currentDemoMode = false;
let currentFarms = [];
let currentHouseStates = {};
let currentLightStates = {};
let selectedFarmFilter = 'all';

// สีสำหรับพล็อตกราฟหลายโรงเรือนแบบอัตโนมัติ
const CHART_PALETTE = [
  { temp: '#f43f5e', hum: '#fb923c' },
  { temp: '#0ea5e9', hum: '#8b5cf6' },
  { temp: '#10b981', hum: '#14b8a6' },
  { temp: '#eab308', hum: '#ec4899' },
  { temp: '#6366f1', hum: '#f97316' },
  { temp: '#a855f7', hum: '#06b6d4' }
];

// -----------------------------------------------------------------
// INITIALIZATION
// -----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  const coopIdInput = document.getElementById('quick-coop-id');
  if (coopIdInput) {
    coopIdInput.addEventListener('input', () => {
      const preview = document.getElementById('quick-coop-topic-preview');
      const val = coopIdInput.value.trim() || 'house4';
      if (preview) preview.innerText = `smartfarm_iot_2026/${val}/telemetry`;
    });
  }
});

// Helper สำหรับเรียก API พร้อมแนบ Token
async function apiFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    showLoginScreen();
    throw new Error('Unauthorized');
  }
  return res;
}

// -----------------------------------------------------------------
// 1. AUTHENTICATION (เข้าด้วย 1 คลิก หรือกรอกรหัสเอง)
// -----------------------------------------------------------------
function quickLogin(username, password) {
  document.getElementById('login-username').value = username;
  document.getElementById('login-password').value = password;
  handleLogin();
}

async function handleLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btnEl = document.getElementById('login-submit-btn');

  errEl.classList.add('hidden');
  if (btnEl) btnEl.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      errEl.innerText = data.error || 'เข้าสู่ระบบไม่สำเร็จ';
      errEl.classList.remove('hidden');
      if (btnEl) btnEl.disabled = false;
      return;
    }

    authToken = data.token;
    currentUser = data.user;
    if (btnEl) btnEl.disabled = false;
    onLoginSuccess();
  } catch (err) {
    errEl.innerText = 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
    errEl.classList.remove('hidden');
    if (btnEl) btnEl.disabled = false;
  }
}

function onLoginSuccess() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');

  const roleBadge = document.getElementById('user-role-badge');
  const isAdmin = currentUser && currentUser.role === 'admin';

  if (roleBadge) {
    roleBadge.innerHTML = isAdmin
      ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Admin (${currentUser.username})`
      : `<span class="w-1.5 h-1.5 rounded-full bg-sky-500"></span> User (${currentUser.username})`;
  }

  // แสดง/ซ่อน ปุ่มเฉพาะ Admin
  const adminBtns = ['navbar-admin-btn', 'menu-admin-btn', 'section-add-coop-btn'];
  adminBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (isAdmin) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  });

  if (!isAdmin) {
    toggleInlineAddFarm(false);
  }

  if (!historyChart) {
    initChart();
  }

  fetchTopologyAndRender();
  fetchDemoMode();
  fetchRules();
}

async function handleLogout() {
  try {
    if (authToken) {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    }
  } catch (_) {}
  authToken = null;
  currentUser = null;
  toggleMenu(false);
  closeAdminModal();
  closeAddCoopModal();
  showLoginScreen();
}

function showLoginScreen() {
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}

async function downloadCSV() {
  try {
    const res = await apiFetch('/api/export/csv');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chicken_farm_data.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    alert('ไม่สามารถดาวน์โหลด CSV ได้');
  }
}

// -----------------------------------------------------------------
// 2. TOPOLOGY: FARM TABS BAR & COOPS DYNAMIC RENDERING
// -----------------------------------------------------------------
async function fetchTopologyAndRender() {
  try {
    const res = await apiFetch('/api/topology');
    const data = await res.json();
    applyTopology(data.farms || [], data.houses || {});
  } catch (err) {
    console.error('Failed to fetch topology:', err);
  }
}

function applyTopology(farms, houses) {
  currentFarms = farms;
  currentHouseStates = houses;

  if (selectedFarmFilter !== 'all' && !currentFarms.some(f => f.id === selectedFarmFilter)) {
    selectedFarmFilter = 'all';
  }

  renderFarmTabsBar();
  renderCoopSelectors();
  renderCoopsGrid();
  updateMasterLightButtons();
  fetchHistoryData();
}

function renderFarmTabsBar() {
  const bar = document.getElementById('farm-tabs-bar');
  if (!bar) return;

  const isAdmin = currentUser && currentUser.role === 'admin';
  const allCount = Object.keys(currentHouseStates).length;

  let html = `
    <button type="button" onclick="selectFarmTab('all')"
            class="sh-btn ${selectedFarmFilter === 'all' ? 'sh-btn-primary' : 'sh-btn-outline'} h-8 px-3">
      <i class="fa-solid fa-layer-group text-[11px]"></i>
      <span>ทุกฟาร์ม (${allCount})</span>
    </button>
  `;

  currentFarms.forEach(f => {
    const count = Object.values(currentHouseStates).filter(c => c.farmId === f.id).length;
    const isActive = selectedFarmFilter === f.id;
    const canDelete = isAdmin && currentFarms.length > 1;

    html += `
      <div class="inline-flex items-center">
        <button type="button" onclick="selectFarmTab('${f.id}')"
                class="sh-btn ${isActive ? 'sh-btn-primary' : 'sh-btn-outline'} h-8 px-3 ${canDelete ? 'rounded-r-none border-r-0' : ''}">
          <span>${f.name} (${count})</span>
        </button>
        ${canDelete ? `
          <button type="button" onclick="deleteFarm('${f.id}')" title="ลบฟาร์ม ${f.name}"
                  class="sh-btn ${isActive ? 'sh-btn-primary' : 'sh-btn-outline'} h-8 px-2 rounded-l-none text-muted-foreground hover:text-rose-500">
            <i class="fa-solid fa-xmark text-[10px]"></i>
          </button>
        ` : ''}
      </div>
    `;
  });

  if (isAdmin) {
    html += `
      <button type="button" onclick="toggleInlineAddFarm(true)"
              class="sh-btn sh-btn-outline h-8 px-3 border-dashed">
        <i class="fa-solid fa-plus text-[11px]"></i>
        <span>เพิ่มฟาร์ม</span>
      </button>
    `;
  }

  bar.innerHTML = html;

  const heading = document.getElementById('current-farm-heading');
  if (heading) {
    if (selectedFarmFilter === 'all') {
      heading.innerText = 'สถานะโรงเลี้ยงไก่ Real-time (ทุกฟาร์ม)';
    } else {
      const f = currentFarms.find(x => x.id === selectedFarmFilter);
      heading.innerText = f ? `สถานะโรงเลี้ยงไก่ - ${f.name}` : 'สถานะโรงเลี้ยงไก่ Real-time';
    }
  }
}

function selectFarmTab(farmId) {
  selectedFarmFilter = farmId;
  renderFarmTabsBar();
  renderCoopSelectors();
  renderCoopsGrid();
  updateMasterLightButtons();
  fetchHistoryData();
}

function toggleInlineAddFarm(show) {
  const form = document.getElementById('inline-add-farm-form');
  const input = document.getElementById('inline-farm-name');
  if (!form) return;
  if (show) {
    form.classList.remove('hidden');
    form.classList.add('flex');
    if (input) {
      input.value = '';
      input.focus();
    }
  } else {
    form.classList.add('hidden');
    form.classList.remove('flex');
  }
}

async function handleInlineCreateFarm(e) {
  e.preventDefault();
  const input = document.getElementById('inline-farm-name');
  const name = input ? input.value.trim() : '';
  if (!name) return;

  try {
    const res = await apiFetch('/api/farms', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'สร้างฟาร์มไม่สำเร็จ');

    toggleInlineAddFarm(false);
    if (data.id) {
      selectedFarmFilter = data.id;
    }
    fetchTopologyAndRender();
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการสร้างฟาร์ม');
  }
}

async function deleteFarm(farmId) {
  const farm = currentFarms.find(f => f.id === farmId);
  if (!confirm(`ยืนยันการลบฟาร์ม "${farm ? farm.name : farmId}" และโรงเรือนทั้งหมดในฟาร์มนี้?`)) return;
  try {
    const res = await apiFetch(`/api/farms/${farmId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'ลบฟาร์มไม่สำเร็จ');
    if (selectedFarmFilter === farmId) selectedFarmFilter = 'all';
    fetchTopologyAndRender();
  } catch (err) {
    alert('ลบฟาร์มไม่สำเร็จ');
  }
}

function getFilteredCoops() {
  return Object.values(currentHouseStates).filter(c => {
    if (selectedFarmFilter !== 'all' && c.farmId !== selectedFarmFilter) return false;
    return true;
  });
}

function renderCoopSelectors() {
  const chartSelect = document.getElementById('chart-house-select');
  const ruleSelect = document.getElementById('rule-house');
  const filteredCoops = getFilteredCoops();

  if (chartSelect) {
    const prev = chartSelect.value || 'all';
    let html = `<option value="all">รวมทุกโรงเรือนที่แสดง (${filteredCoops.length})</option>`;
    filteredCoops.forEach(c => {
      html += `<option value="${c.id}">${c.name} (${c.farmName})</option>`;
    });
    chartSelect.innerHTML = html;
    if (prev === 'all' || filteredCoops.some(c => c.id === prev)) {
      chartSelect.value = prev;
    } else {
      chartSelect.value = 'all';
    }
  }

  if (ruleSelect) {
    const allCoops = Object.values(currentHouseStates);
    let rHtml = `<option value="all">ทุกโรงเรือน</option>`;
    allCoops.forEach(c => {
      rHtml += `<option value="${c.id}">${c.name} [${c.id}]</option>`;
    });
    ruleSelect.innerHTML = rHtml;
  }
}

function renderCoopsGrid() {
  const grid = document.getElementById('coops-grid');
  if (!grid) return;

  const coops = getFilteredCoops();
  const isAdmin = currentUser && currentUser.role === 'admin';

  const cardsHtml = coops.map(c => `
    <div id="card-${c.id}" class="sh-card p-6 flex flex-col justify-between space-y-5">
      <div class="flex justify-between items-start gap-2">
        <div class="space-y-1">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] font-medium text-muted-foreground">${c.farmName}</span>
            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">${c.id}</span>
          </div>
          <h3 class="text-base font-semibold tracking-tight text-foreground">${c.name}</h3>
        </div>
        <div class="flex items-center gap-1.5">
          <div id="badge-online-${c.id}" class="sh-badge bg-muted text-muted-foreground">
            <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Offline
          </div>
          ${isAdmin ? `
            <button type="button" onclick="deleteCoop('${c.id}')" title="ลบโรงเรือน ${c.name}"
                    class="sh-btn sh-btn-outline w-7 h-7 p-0 text-muted-foreground hover:text-rose-500">
              <i class="fa-regular fa-trash-can text-[11px]"></i>
            </button>
          ` : ''}
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-md border border-border bg-muted/40 p-3.5 text-center">
          <span class="text-xs text-muted-foreground font-medium">อุณหภูมิ</span>
          <div class="text-2xl font-bold tracking-tight text-foreground mt-1">
            <span id="temp-${c.id}">0.0</span>
            <span class="text-xs font-normal text-muted-foreground ml-0.5">°C</span>
          </div>
        </div>
        <div class="rounded-md border border-border bg-muted/40 p-3.5 text-center">
          <span class="text-xs text-muted-foreground font-medium">ความชื้น</span>
          <div class="text-2xl font-bold tracking-tight text-foreground mt-1">
            <span id="hum-${c.id}">0.0</span>
            <span class="text-xs font-normal text-muted-foreground ml-0.5">%</span>
          </div>
        </div>
      </div>

      <div class="rounded-md border border-border bg-muted/20 px-3.5 py-2.5 flex justify-between items-center text-xs">
        <span class="text-muted-foreground font-medium">ดัชนี THI:</span>
        <span id="thi-${c.id}" class="text-muted-foreground font-medium">ออฟไลน์ (0.0 THI)</span>
      </div>

      <div class="pt-4 border-t border-border flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-foreground">ไฟส่องสว่าง</div>
          <div id="light-status-${c.id}" class="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span> ปิดอยู่ (Offline)
          </div>
        </div>

        <button id="light-toggle-btn-${c.id}" onclick="toggleLight('${c.id}')" disabled
                class="sh-btn sh-btn-outline h-9 px-3.5">
          <span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
          <span id="light-btn-text-${c.id}">ออฟไลน์</span>
        </button>
      </div>
    </div>
  `).join('');

  // การ์ดปุ่มลัด "+ เพิ่มโรงเรือนใหม่" สำหรับ Admin วางต่อท้ายใน Grid เลย
  const addCardHtml = isAdmin ? `
    <button type="button" onclick="openAddCoopModal()"
            class="sh-card border-dashed hover:border-foreground/40 hover:bg-muted/30 transition p-6 flex flex-col items-center justify-center gap-2 min-h-[240px] cursor-pointer text-muted-foreground hover:text-foreground">
      <div class="w-10 h-10 rounded-full border border-border bg-muted flex items-center justify-center">
        <i class="fa-solid fa-plus text-sm"></i>
      </div>
      <div class="text-sm font-semibold">เพิ่มโรงเรือนใหม่ (Coop)</div>
      <div class="text-xs text-muted-foreground text-center">คลิกเพื่อสร้างโรงเรือนและรับค่า MQTT ทันที</div>
    </button>
  ` : '';

  if (coops.length === 0 && !isAdmin) {
    grid.innerHTML = `
      <div class="col-span-full sh-card p-8 text-center text-xs text-muted-foreground">
        ยังไม่มีโรงเรือนในฟาร์มนี้
      </div>
    `;
    return;
  }

  grid.innerHTML = cardsHtml + addCardHtml;
  coops.forEach(c => updateHouseUI(c.id, c));
}

// -----------------------------------------------------------------
// QUICK ADD COOP MODAL (เฉพาะ Admin - กรอกค่าเริ่มต้นให้อัตโนมัติ)
// -----------------------------------------------------------------
function openAddCoopModal() {
  if (!currentUser || currentUser.role !== 'admin') return;
  const modal = document.getElementById('add-coop-modal');
  const nameInput = document.getElementById('quick-coop-name');
  const idInput = document.getElementById('quick-coop-id');
  const farmSelect = document.getElementById('quick-coop-farm');
  const topicPreview = document.getElementById('quick-coop-topic-preview');

  // คำนวณเลขโรงเรือนถัดไปอัตโนมัติ เช่น house4, Chicken House #4
  let nextNum = Object.keys(currentHouseStates).length + 1;
  while (currentHouseStates[`house${nextNum}`]) {
    nextNum++;
  }
  const nextId = `house${nextNum}`;

  if (farmSelect) {
    farmSelect.innerHTML = currentFarms.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
    if (selectedFarmFilter !== 'all' && currentFarms.some(f => f.id === selectedFarmFilter)) {
      farmSelect.value = selectedFarmFilter;
    } else if (currentFarms[0]) {
      farmSelect.value = currentFarms[0].id;
    }
  }

  if (nameInput) nameInput.value = `Chicken House #${nextNum}`;
  if (idInput) idInput.value = nextId;
  if (topicPreview) topicPreview.innerText = `smartfarm_iot_2026/${nextId}/telemetry`;

  if (modal) modal.classList.remove('hidden');
  if (nameInput) nameInput.focus();
}

function closeAddCoopModal() {
  const modal = document.getElementById('add-coop-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleQuickCreateCoop(e) {
  e.preventDefault();
  const name = document.getElementById('quick-coop-name').value.trim();
  const farm_id = document.getElementById('quick-coop-farm').value;
  const id = document.getElementById('quick-coop-id').value.trim();

  try {
    const res = await apiFetch('/api/coops', {
      method: 'POST',
      body: JSON.stringify({ id, farm_id, name })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'สร้างโรงเรือนไม่สำเร็จ');

    closeAddCoopModal();
    fetchTopologyAndRender();
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการสร้างโรงเรือน');
  }
}

async function deleteCoop(coopId) {
  const coop = currentHouseStates[coopId];
  if (!confirm(`ยืนยันการลบโรงเรือน "${coop ? coop.name : coopId}"?`)) return;
  try {
    const res = await apiFetch(`/api/coops/${coopId}`, { method: 'DELETE' });
    if (!res.ok) return alert('ลบโรงเรือนไม่สำเร็จ');
    fetchTopologyAndRender();
  } catch (err) {
    alert('ลบโรงเรือนไม่สำเร็จ');
  }
}

// -----------------------------------------------------------------
// 3. DEMO MODE & REAL HARDWARE TOGGLE
// -----------------------------------------------------------------
async function fetchDemoMode() {
  try {
    const res = await apiFetch('/api/demo');
    const data = await res.json();
    updateDemoUI(data.demoMode);
  } catch (e) {
    console.error('Fetch demo mode error:', e);
  }
}

async function toggleDemoMode(forceVal) {
  try {
    const targetVal = typeof forceVal === 'boolean' ? forceVal : !currentDemoMode;
    const res = await apiFetch('/api/demo', {
      method: 'POST',
      body: JSON.stringify({ enabled: targetVal })
    });
    const data = await res.json();
    updateDemoUI(data.demoMode);
  } catch (e) {
    console.error('Toggle demo mode error:', e);
  }
}

function updateDemoUI(demoMode) {
  currentDemoMode = demoMode;

  const quickDot = document.getElementById('quick-mode-dot');
  const quickText = document.getElementById('quick-mode-text');
  const quickBtn = document.getElementById('quick-demo-toggle');
  const menuBtnText = document.getElementById('demo-btn-text');

  if (demoMode) {
    if (quickDot) quickDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
    if (quickText) quickText.innerText = 'ข้อมูลตัวอย่าง (Demo)';
    if (quickBtn) quickBtn.className = 'sh-btn sh-btn-primary h-9 px-3';
    if (menuBtnText) menuBtnText.innerText = 'ปิดข้อมูลตัวอย่าง';
  } else {
    if (quickDot) quickDot.className = 'w-2 h-2 rounded-full bg-zinc-400';
    if (quickText) quickText.innerText = 'โหมดตรวจบอร์ดจริง';
    if (quickBtn) quickBtn.className = 'sh-btn sh-btn-outline h-9 px-3';
    if (menuBtnText) menuBtnText.innerText = 'เปิดข้อมูลตัวอย่าง';
  }

  updateMasterLightButtons();
}

socket.on('demo_status', ({ demoMode }) => {
  if (!authToken) return;
  updateDemoUI(demoMode);
  fetchTopologyAndRender();
});

socket.on('topology_updated', ({ farms, houses }) => {
  if (!authToken) return;
  applyTopology(farms || [], houses || {});
});

// -----------------------------------------------------------------
// 4. THEME SWITCHER & SIDEBAR MENU (3 ขีด)
// -----------------------------------------------------------------
let isMenuOpen = false;

function toggleMenu(forceState) {
  const sideMenu = document.getElementById('side-menu');
  const backdrop = document.getElementById('menu-backdrop');
  const bar1 = document.getElementById('bar-1');
  const bar2 = document.getElementById('bar-2');
  const bar3 = document.getElementById('bar-3');

  if (typeof forceState === 'boolean') {
    isMenuOpen = forceState;
  } else {
    isMenuOpen = !isMenuOpen;
  }

  if (isMenuOpen) {
    if (sideMenu) sideMenu.classList.remove('translate-x-full');
    if (backdrop) {
      backdrop.classList.remove('opacity-0', 'pointer-events-none');
      backdrop.classList.add('opacity-100', 'pointer-events-auto');
    }
    if (bar1) bar1.classList.add('rotate-45', 'translate-y-[5.5px]');
    if (bar2) bar2.classList.add('opacity-0');
    if (bar3) bar3.classList.add('-rotate-45', '-translate-y-[5.5px]');
  } else {
    if (sideMenu) sideMenu.classList.add('translate-x-full');
    if (backdrop) {
      backdrop.classList.add('opacity-0', 'pointer-events-none');
      backdrop.classList.remove('opacity-100', 'pointer-events-auto');
    }
    if (bar1) bar1.classList.remove('rotate-45', 'translate-y-[5.5px]');
    if (bar2) bar2.classList.remove('opacity-0');
    if (bar3) bar3.classList.remove('-rotate-45', '-translate-y-[5.5px]');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isMenuOpen) toggleMenu(false);
    closeAdminModal();
    closeAddCoopModal();
  }
});

function initTheme() {
  const savedTheme = localStorage.getItem('farm-theme') || 'dark';
  applyTheme(savedTheme);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const nextTheme = isDark ? 'light' : 'dark';
  applyTheme(nextTheme);
  localStorage.setItem('farm-theme', nextTheme);
  updateChartTheme();
}

function applyTheme(theme) {
  const html = document.documentElement;
  const textEl = document.getElementById('theme-text');
  const iconEl = document.getElementById('theme-icon');

  if (theme === 'dark') {
    html.classList.add('dark');
    if (textEl) textEl.innerText = 'โหมดมืด';
    if (iconEl) iconEl.innerHTML = '<i class="fa-solid fa-moon"></i>';
  } else {
    html.classList.remove('dark');
    if (textEl) textEl.innerText = 'โหมดสว่าง';
    if (iconEl) iconEl.innerHTML = '<i class="fa-solid fa-sun"></i>';
  }
}

function updateChartTheme() {
  if (!historyChart) return;
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? '#27272a' : '#e4e4e7';
  const labelColor = isDark ? '#a1a1aa' : '#71717a';

  historyChart.options.plugins.legend.labels.color = labelColor;
  historyChart.options.scales.x.ticks.color = labelColor;
  historyChart.options.scales.x.grid.color = gridColor;
  historyChart.options.scales.yTemp.grid.color = gridColor;
  historyChart.update();
}

// -----------------------------------------------------------------
// 5. SOCKET.IO REALTIME EVENTS
// -----------------------------------------------------------------
socket.on('telemetry', (payload) => {
  if (!authToken) return;
  const { houseId, data } = payload;
  currentHouseStates[houseId] = data;
  updateHouseUI(houseId, data);
  updateMasterLightButtons();

  if (!historyChart) return;
  if (!data.online && !currentDemoMode) return;

  const selectedHouse = document.getElementById('chart-house-select').value;
  const timeLabel = new Date().toLocaleTimeString('th-TH');

  if (selectedHouse === houseId) {
    historyChart.data.labels.push(timeLabel);
    historyChart.data.datasets.forEach(ds => {
      if (ds.yAxisID === 'yTemp') ds.data.push(data.temp);
      if (ds.yAxisID === 'yHum') ds.data.push(data.hum);
    });

    if (historyChart.data.labels.length > 25) {
      historyChart.data.labels.shift();
      historyChart.data.datasets.forEach(ds => ds.data.shift());
    }
    historyChart.update('none');
  } else if (selectedHouse === 'all') {
    if (selectedFarmFilter !== 'all' && data.farmId !== selectedFarmFilter) return;
    const tag = `[${houseId}]`;
    let found = false;

    historyChart.data.datasets.forEach(ds => {
      if (ds.label && ds.label.includes(tag)) {
        found = true;
        if (ds.yAxisID === 'yTemp') ds.data.push(data.temp);
        if (ds.yAxisID === 'yHum') ds.data.push(data.hum);
        if (ds.data.length > historyChart.data.labels.length) {
          historyChart.data.labels.push(timeLabel);
        }
      }
    });

    if (!found) {
      fetchHistoryData();
      return;
    }

    if (historyChart.data.labels.length > 25) {
      historyChart.data.labels.shift();
      historyChart.data.datasets.forEach(ds => {
        if (ds.data.length > 25) ds.data.shift();
      });
    }
    historyChart.update('none');
  }
});

socket.on('light_status', ({ houseId, state }) => {
  if (!authToken) return;
  updateLightUI(houseId, state);
});

socket.on('security_log', () => {
  if (!authToken || !currentUser || currentUser.role !== 'admin') return;
  const secTab = document.getElementById('admin-tab-security');
  if (secTab && !secTab.classList.contains('hidden')) {
    fetchSecurityData();
  }
});

// -----------------------------------------------------------------
// 6. UI UPDATE HELPERS & LIGHT CONTROLS
// -----------------------------------------------------------------
function updateMasterLightButtons() {
  const coops = getFilteredCoops();
  const anyOnline = coops.some(h => h && h.online);
  const onBtn = document.getElementById('master-light-on-btn');
  const offBtn = document.getElementById('master-light-off-btn');
  if (onBtn) onBtn.disabled = !anyOnline;
  if (offBtn) offBtn.disabled = !anyOnline;
}

function updateHouseUI(houseId, data) {
  const tempEl = document.getElementById(`temp-${houseId}`);
  const humEl = document.getElementById(`hum-${houseId}`);
  const thiEl = document.getElementById(`thi-${houseId}`);
  const badgeEl = document.getElementById(`badge-online-${houseId}`);
  const isOnline = !!data.online;

  if (badgeEl) {
    if (isOnline) {
      badgeEl.className = 'sh-badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
      badgeEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Online';
    } else {
      badgeEl.className = 'sh-badge bg-muted text-muted-foreground';
      badgeEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Offline';
    }
  }

  if (tempEl) {
    tempEl.innerText = isOnline ? Number(data.temp).toFixed(1) : '0.0';
  }

  if (humEl) {
    humEl.innerText = isOnline ? Number(data.hum).toFixed(1) : '0.0';
  }

  if (thiEl) {
    if (isOnline && data.thi) {
      let statusText = `ปกติ (${data.thi} THI)`;
      let colorClass = 'text-emerald-600 dark:text-emerald-400 font-semibold';

      if (data.thi >= 80) {
        statusText = `อันตราย (${data.thi} THI)`;
        colorClass = 'text-rose-600 dark:text-rose-400 font-semibold';
      } else if (data.thi >= 75) {
        statusText = `เครียดปานกลาง (${data.thi} THI)`;
        colorClass = 'text-amber-600 dark:text-amber-400 font-semibold';
      }

      thiEl.innerText = statusText;
      thiEl.className = colorClass;
    } else {
      thiEl.innerText = 'ออฟไลน์ (0.0 THI)';
      thiEl.className = 'text-muted-foreground font-medium';
    }
  }

  updateLightUI(houseId, isOnline ? (data.light || 'OFF') : 'OFF');
}

function toggleLight(houseId) {
  if (!currentHouseStates[houseId] || !currentHouseStates[houseId].online) return;
  const currentState = currentLightStates[houseId] || 'OFF';
  const nextAction = currentState === 'ON' ? 'OFF' : 'ON';
  setLight(houseId, nextAction);
}

function updateLightUI(houseId, state) {
  const isOnline = !!(currentHouseStates[houseId] && currentHouseStates[houseId].online);
  currentLightStates[houseId] = isOnline ? state : 'OFF';

  const btnEl = document.getElementById(`light-toggle-btn-${houseId}`);
  const statusEl = document.getElementById(`light-status-${houseId}`);
  const isLightOn = isOnline && state === 'ON';

  if (statusEl) {
    if (!isOnline) {
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span> <span class="text-muted-foreground">ปิดอยู่ (Offline)</span>`;
    } else if (isLightOn) {
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> <span class="text-foreground font-medium">เปิดอยู่ (ON)</span>`;
    } else {
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span> <span class="text-muted-foreground">ปิดอยู่ (OFF)</span>`;
    }
  }

  if (btnEl) {
    if (!isOnline) {
      btnEl.disabled = true;
      btnEl.className = 'sh-btn sh-btn-outline h-9 px-3.5';
      btnEl.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
        <span>ออฟไลน์</span>
      `;
    } else if (isLightOn) {
      btnEl.disabled = false;
      btnEl.className = 'sh-btn sh-btn-primary h-9 px-3.5';
      btnEl.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        <span>เปิดอยู่</span>
      `;
    } else {
      btnEl.disabled = false;
      btnEl.className = 'sh-btn sh-btn-outline h-9 px-3.5';
      btnEl.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
        <span>ปิดอยู่</span>
      `;
    }
  }
}

async function setLight(houseId, action) {
  try {
    await apiFetch('/api/light', {
      method: 'POST',
      body: JSON.stringify({ houseId, farmId: selectedFarmFilter, action })
    });
  } catch (err) {
    alert('ส่งคำสั่งไม่สำเร็จ');
  }
}

async function controlAllLight(action) {
  const coops = getFilteredCoops();
  const anyOnline = coops.some(h => h && h.online);
  if (!anyOnline) return;
  setLight('all', action);
}

// -----------------------------------------------------------------
// 7. CHART.JS SETUP & DYNAMIC RENDERING
// -----------------------------------------------------------------
function initChart() {
  const ctx = document.getElementById('historyChart').getContext('2d');
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? '#27272a' : '#e4e4e7';
  const labelColor = isDark ? '#a1a1aa' : '#71717a';

  historyChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: labelColor, boxWidth: 12, font: { size: 11 } } }
      },
      scales: {
        x: {
          ticks: { color: labelColor, font: { size: 11 } },
          grid: { color: gridColor }
        },
        yTemp: {
          type: 'linear',
          display: true,
          position: 'left',
          suggestedMin: 0,
          title: { display: true, text: 'อุณหภูมิ (°C)', color: '#f43f5e', font: { size: 11 } },
          ticks: { color: '#f43f5e', font: { size: 11 } },
          grid: { color: gridColor }
        },
        yHum: {
          type: 'linear',
          display: true,
          position: 'right',
          suggestedMin: 0,
          title: { display: true, text: 'ความชื้น (%)', color: '#0ea5e9', font: { size: 11 } },
          ticks: { color: '#0ea5e9', font: { size: 11 } },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

async function fetchHistoryData() {
  if (!authToken) return;
  const houseSelect = document.getElementById('chart-house-select');
  const metricSelect = document.getElementById('chart-metric-select');
  if (!houseSelect) return;

  const houseId = houseSelect.value || 'all';
  const metric = metricSelect ? metricSelect.value : 'both';

  try {
    const res = await apiFetch(`/api/history?farm=${selectedFarmFilter}&house=${houseId}&limit=25`);
    const data = await res.json();

    if (!historyChart) return;

    if (houseId === 'all') {
      renderMultiCoopsChart(data, metric);
    } else {
      renderSingleHouseChart(data, metric, houseId);
    }
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function renderSingleHouseChart(data, metric, houseId) {
  const coop = currentHouseStates[houseId];
  const titleName = coop ? `${coop.name} [${houseId}]` : houseId;
  const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString('th-TH'));
  const temps = data.map(d => d.temperature);
  const hums = data.map(d => d.humidity);

  const datasets = [];

  if (metric === 'both' || metric === 'temp') {
    datasets.push({
      label: `${titleName} - อุณหภูมิ (°C)`,
      data: temps,
      borderColor: '#f43f5e',
      backgroundColor: 'rgba(244, 63, 94, 0.08)',
      yAxisID: 'yTemp',
      tension: 0.3,
      borderWidth: 2,
      fill: true
    });
  }

  if (metric === 'both' || metric === 'hum') {
    datasets.push({
      label: `${titleName} - ความชื้น (%)`,
      data: hums,
      borderColor: '#0ea5e9',
      backgroundColor: 'rgba(14, 165, 233, 0.08)',
      yAxisID: 'yHum',
      tension: 0.3,
      borderWidth: 2,
      fill: true
    });
  }

  historyChart.data.labels = labels;
  historyChart.data.datasets = datasets;
  historyChart.options.scales.yTemp.display = (metric === 'both' || metric === 'temp');
  historyChart.options.scales.yHum.display = (metric === 'both' || metric === 'hum');
  historyChart.update();
}

function renderMultiCoopsChart(data, metric) {
  const coops = getFilteredCoops();
  let longestSeries = [];
  const grouped = {};

  coops.forEach(c => {
    const rows = data.filter(d => d.house_id === c.id);
    grouped[c.id] = rows;
    if (rows.length > longestSeries.length) {
      longestSeries = rows;
    }
  });

  const labels = longestSeries.map(d => new Date(d.timestamp).toLocaleTimeString('th-TH'));
  const datasets = [];

  if (metric === 'both' || metric === 'temp') {
    coops.forEach((c, idx) => {
      const palette = CHART_PALETTE[idx % CHART_PALETTE.length];
      datasets.push({
        label: `${c.name} [${c.id}] - อุณหภูมิ (°C)`,
        data: (grouped[c.id] || []).map(d => d.temperature),
        borderColor: palette.temp,
        backgroundColor: 'transparent',
        yAxisID: 'yTemp',
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 2
      });
    });
  }

  if (metric === 'both' || metric === 'hum') {
    coops.forEach((c, idx) => {
      const palette = CHART_PALETTE[idx % CHART_PALETTE.length];
      datasets.push({
        label: `${c.name} [${c.id}] - ความชื้น (%)`,
        data: (grouped[c.id] || []).map(d => d.humidity),
        borderColor: palette.hum,
        backgroundColor: 'transparent',
        borderDash: [4, 4],
        yAxisID: 'yHum',
        tension: 0.3,
        borderWidth: 1.5,
        pointRadius: 2
      });
    });
  }

  historyChart.data.labels = labels;
  historyChart.data.datasets = datasets;
  historyChart.options.scales.yTemp.display = (metric === 'both' || metric === 'temp');
  historyChart.options.scales.yHum.display = (metric === 'both' || metric === 'hum');
  historyChart.update();
}

// -----------------------------------------------------------------
// 8. AUTOMATION RULE ENGINE
// -----------------------------------------------------------------
async function fetchRules() {
  if (!authToken) return;
  try {
    const res = await apiFetch('/api/rules');
    const rules = await res.json();
    const listEl = document.getElementById('rules-list');

    if (rules.length === 0) {
      listEl.innerHTML = `<div class="text-xs text-muted-foreground text-center py-6 rounded-md border border-dashed border-border">ยังไม่มีเงื่อนไข Automation Rule</div>`;
      return;
    }

    listEl.innerHTML = rules.map(r => `
      <div class="rounded-md border border-border bg-card px-4 py-3 flex justify-between items-center text-xs">
        <div class="flex items-center gap-3">
          <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
          <div>
            <strong class="text-foreground font-medium">${r.name}</strong>
            <span class="text-muted-foreground ml-2">IF [${r.house_id}] ${r.metric} ${r.operator} ${r.threshold} → THEN Light: <b class="text-foreground font-semibold">${r.action}</b></span>
          </div>
        </div>
        <button onclick="deleteRule(${r.id})" class="sh-btn sh-btn-outline h-8 px-3 text-rose-500 hover:text-rose-600">
          ลบ
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Fetch rules failed:', err);
  }
}

async function createRule(e) {
  e.preventDefault();
  const rule = {
    name: document.getElementById('rule-name').value,
    house_id: document.getElementById('rule-house').value,
    metric: document.getElementById('rule-metric').value,
    operator: document.getElementById('rule-op').value,
    threshold: parseFloat(document.getElementById('rule-val').value),
    action: document.getElementById('rule-action').value
  };

  try {
    await apiFetch('/api/rules', {
      method: 'POST',
      body: JSON.stringify(rule)
    });
    document.getElementById('rule-form').reset();
    fetchRules();
  } catch (err) {
    alert('สร้าง Rule ไม่สำเร็จ');
  }
}

async function deleteRule(id) {
  try {
    await apiFetch(`/api/rules/${id}`, { method: 'DELETE' });
    fetchRules();
  } catch (err) {
    alert('ลบไม่สำเร็จ');
  }
}

// -----------------------------------------------------------------
// 9. ADMIN USERS & SENSOR SECURITY MODAL
// -----------------------------------------------------------------
function openAdminModal(defaultTab = 'users') {
  if (!currentUser || currentUser.role !== 'admin') return;
  document.getElementById('admin-modal').classList.remove('hidden');
  switchAdminTab(defaultTab);
}

function closeAdminModal() {
  const modal = document.getElementById('admin-modal');
  if (modal) modal.classList.add('hidden');
}

function switchAdminTab(tab) {
  const tabs = ['users', 'security'];
  tabs.forEach(t => {
    const contentEl = document.getElementById(`admin-tab-${t}`);
    const btnEl = document.getElementById(`tab-btn-${t}`);
    if (!contentEl || !btnEl) return;
    if (t === tab) {
      contentEl.classList.remove('hidden');
      btnEl.className = 'px-3 py-2 text-xs font-medium border-b-2 border-primary text-foreground transition cursor-pointer';
    } else {
      contentEl.classList.add('hidden');
      btnEl.className = 'px-3 py-2 text-xs font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition cursor-pointer';
    }
  });

  if (tab === 'users') fetchAdminUsers();
  if (tab === 'security') fetchSecurityData();
}

async function fetchAdminUsers() {
  try {
    const res = await apiFetch('/api/users');
    const users = await res.json();
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;

    listEl.innerHTML = users.map(u => `
      <div class="rounded-md border border-border bg-card px-3.5 py-2 flex justify-between items-center text-xs">
        <div class="flex items-center gap-2">
          <span class="font-medium text-foreground">${u.username}</span>
          <span class="sh-badge ${u.role === 'admin' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}">${u.role}</span>
        </div>
        ${u.id !== currentUser.id ? `
          <button onclick="deleteUser(${u.id})" class="sh-btn sh-btn-outline h-7 px-2.5 text-rose-500 hover:text-rose-600">ลบ</button>
        ` : `<span class="text-[11px] text-muted-foreground">กำลังใช้งาน</span>`}
      </div>
    `).join('');
  } catch (err) {
    console.error('Fetch users error:', err);
  }
}

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('new-user-name').value.trim();
  const password = document.getElementById('new-user-pass').value;
  const role = document.getElementById('new-user-role').value;

  try {
    const res = await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'สร้างผู้ใช้ไม่สำเร็จ');
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-pass').value = '';
    fetchAdminUsers();
  } catch (err) {
    alert('สร้างผู้ใช้ไม่สำเร็จ');
  }
}

async function deleteUser(userId) {
  try {
    const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'ลบผู้ใช้ไม่สำเร็จ');
    fetchAdminUsers();
  } catch (err) {
    alert('ลบผู้ใช้ไม่สำเร็จ');
  }
}

async function fetchSecurityData() {
  try {
    const res = await apiFetch('/api/security/status');
    const data = await res.json();

    const reqKeyEl = document.getElementById('sec-require-key');
    const valRangeEl = document.getElementById('sec-validate-range');
    if (reqKeyEl && data.config) reqKeyEl.checked = !!data.config.requireSensorKey;
    if (valRangeEl && data.config) valRangeEl.checked = !!data.config.validateRange;

    const logsEl = document.getElementById('security-logs-list');
    if (logsEl) {
      if (!data.logs || data.logs.length === 0) {
        logsEl.innerHTML = `<div class="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-md">ยังไม่มีประวัติเหตุการณ์</div>`;
      } else {
        logsEl.innerHTML = data.logs.map(l => `
          <div class="rounded-md border border-border bg-card px-3 py-2 flex justify-between items-center text-[11px]">
            <div class="flex items-center gap-2">
              <span class="font-mono px-1.5 py-0.5 rounded ${l.event_type === 'SENSOR_BLOCKED' ? 'bg-rose-500/10 text-rose-500' : 'bg-muted text-muted-foreground'}">${l.event_type}</span>
              <span class="text-foreground">${l.message}</span>
            </div>
            <span class="text-muted-foreground font-mono">${new Date(l.timestamp).toLocaleTimeString('th-TH')}</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Fetch security error:', err);
  }
}

async function updateSecurityConfig() {
  const requireSensorKey = document.getElementById('sec-require-key').checked;
  const validateRange = document.getElementById('sec-validate-range').checked;
  try {
    await apiFetch('/api/security/config', {
      method: 'POST',
      body: JSON.stringify({ requireSensorKey, validateRange })
    });
    fetchSecurityData();
  } catch (err) {
    alert('อัปเดตตั้งค่าความปลอดภัยไม่สำเร็จ');
  }
}
