const socket = io();

let historyChart = null;
const currentLightStates = {
  house1: 'OFF',
  house2: 'OFF',
  house3: 'OFF'
};

// -----------------------------------------------------------------
// INITIALIZATION
// -----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initChart();
  fetchInitialData();
  fetchHistoryData();
  fetchRules();
});

// -----------------------------------------------------------------
// 1. THEME SWITCHER (ขาว / ดำ)
// -----------------------------------------------------------------
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

  if (theme === 'dark') {
    html.classList.add('dark');
    if (textEl) textEl.innerText = 'โหมดมืด (Dark)';
  } else {
    html.classList.remove('dark');
    if (textEl) textEl.innerText = 'โหมดสว่าง (Light)';
  }
}

function updateChartTheme() {
  if (!historyChart) return;
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? '#1e293b' : '#e2e8f0';
  const labelColor = isDark ? '#94a3b8' : '#64748b';

  historyChart.options.plugins.legend.labels.color = labelColor;
  historyChart.options.scales.x.ticks.color = labelColor;
  historyChart.options.scales.x.grid.color = gridColor;
  historyChart.options.scales.yTemp.grid.color = gridColor;
  historyChart.update();
}

// -----------------------------------------------------------------
// 2. SOCKET.IO REALTIME EVENTS
// -----------------------------------------------------------------
socket.on('connect', () => {
  console.log('Connected to Backend via Socket.io');
});

socket.on('telemetry', (payload) => {
  const { houseId, data } = payload;
  updateHouseUI(houseId, data);

  if (!historyChart) return;

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
    const houseNames = { house1: 'โรงเรือน 1', house2: 'โรงเรือน 2', house3: 'โรงเรือน 3' };
    const tag = houseNames[houseId];

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
      // หากยังเป็นโครง dataset เก่า ให้ดึงข้อมูลเปรียบเทียบใหม่ทันที
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
  updateLightUI(houseId, state);
});

// -----------------------------------------------------------------
// 3. UI UPDATE HELPERS
// -----------------------------------------------------------------
function updateHouseUI(houseId, data) {
  const tempEl = document.getElementById(`temp-${houseId}`);
  const humEl = document.getElementById(`hum-${houseId}`);
  const thiEl = document.getElementById(`thi-${houseId}`);
  const badgeEl = document.getElementById(`badge-online-${houseId}`);

  if (tempEl) tempEl.innerText = Number(data.temp).toFixed(1);
  if (humEl) humEl.innerText = Number(data.hum).toFixed(1);

  if (badgeEl) {
    badgeEl.className = 'text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border border-emerald-500/30 font-medium';
    badgeEl.innerText = 'Online';
  }

  // THI calculation display
  if (thiEl && data.thi) {
    let statusText = `ปกติ (${data.thi} THI)`;
    let colorClass = 'text-emerald-600 dark:text-emerald-400 font-bold';

    if (data.thi >= 80) {
      statusText = `อันตราย (${data.thi} THI)`;
      colorClass = 'text-rose-600 dark:text-rose-400 font-bold';
    } else if (data.thi >= 75) {
      statusText = `เครียดปานกลาง (${data.thi} THI)`;
      colorClass = 'text-amber-600 dark:text-amber-400 font-bold';
    }

    thiEl.innerText = statusText;
    thiEl.className = colorClass;
  }

  if (data.light) {
    updateLightUI(houseId, data.light);
  }
}

// -----------------------------------------------------------------
// 4. SINGLE TOGGLE LIGHT CONTROLLER (ปุ่มเดียวดูง่าย)
// -----------------------------------------------------------------
function toggleLight(houseId) {
  const currentState = currentLightStates[houseId] || 'OFF';
  const nextAction = currentState === 'ON' ? 'OFF' : 'ON';
  setLight(houseId, nextAction);
}

function updateLightUI(houseId, state) {
  currentLightStates[houseId] = state;

  const btnEl = document.getElementById(`light-toggle-btn-${houseId}`);
  const iconEl = document.getElementById(`light-icon-${houseId}`);
  const statusEl = document.getElementById(`light-status-${houseId}`);

  const isLightOn = state === 'ON';

  // 1. ปรับไอคอนหลอดไฟ
  if (iconEl) {
    if (isLightOn) {
      iconEl.className = 'w-10 h-10 rounded-xl bg-amber-500/20 text-amber-500 dark:text-amber-400 flex items-center justify-center text-lg transition-all duration-300 shadow-[0_0_15px_rgba(245,158,11,0.4)]';
      iconEl.innerHTML = '<i class="fa-solid fa-lightbulb"></i>';
    } else {
      iconEl.className = 'w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-500 flex items-center justify-center text-lg transition-all duration-300';
      iconEl.innerHTML = '<i class="fa-regular fa-lightbulb"></i>';
    }
  }

  // 2. ปรับข้อความสถานะย่อย
  if (statusEl) {
    if (isLightOn) {
      statusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> <b class="text-amber-600 dark:text-amber-400 font-bold">เปิดอยู่ (ON)</b>`;
    } else {
      statusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> <span class="text-slate-500 dark:text-slate-400">ปิดอยู่ (OFF)</span>`;
    }
  }

  // 3. ปรับปุ่ม Toggle สวิตช์เดียว (แบบเดิม)
  if (btnEl) {
    if (isLightOn) {
      btnEl.className = 'px-4 py-2 rounded-xl text-xs font-bold transition-all duration-300 flex items-center gap-2 shadow-lg cursor-pointer bg-amber-500 hover:bg-amber-600 text-white shadow-[0_0_15px_rgba(245,158,11,0.4)] ring-2 ring-amber-400/40';
      btnEl.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-white animate-pulse"></span>
        <span>เปิดอยู่</span>
      `;
    } else {
      btnEl.className = 'px-4 py-2 rounded-xl text-xs font-bold transition-all duration-300 flex items-center gap-2 shadow-sm cursor-pointer bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300';
      btnEl.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-slate-400"></span>
        <span>ปิดอยู่</span>
      `;
    }
  }
}

// -----------------------------------------------------------------
// 5. REST API CALLS
// -----------------------------------------------------------------
async function fetchInitialData() {
  try {
    const res = await fetch('/api/houses');
    const houses = await res.json();
    Object.keys(houses).forEach(h => {
      if (houses[h].temp > 0 || houses[h].light) {
        updateHouseUI(h, houses[h]);
      }
    });
  } catch (err) {
    console.error('Failed to fetch houses status:', err);
  }
}

async function setLight(houseId, action) {
  try {
    await fetch('/api/light', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ houseId, action })
    });
  } catch (err) {
    alert('ส่งคำสั่งไม่สำเร็จ');
  }
}

async function controlAllLight(action) {
  setLight('all', action);
}

// -----------------------------------------------------------------
// 6. CHART.JS SETUP
// -----------------------------------------------------------------
function initChart() {
  const ctx = document.getElementById('historyChart').getContext('2d');
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? '#1e293b' : '#e2e8f0';
  const labelColor = isDark ? '#94a3b8' : '#64748b';

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'อุณหภูมิ (°C)',
          data: [],
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.1)',
          yAxisID: 'yTemp',
          tension: 0.3,
          fill: true
        },
        {
          label: 'ความชื้น (%)',
          data: [],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          yAxisID: 'yHum',
          tension: 0.3,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: labelColor } }
      },
      scales: {
        x: {
          ticks: { color: labelColor },
          grid: { color: gridColor }
        },
        yTemp: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'อุณหภูมิ (°C)', color: '#f43f5e' },
          ticks: { color: '#f43f5e' },
          grid: { color: gridColor }
        },
        yHum: {
          type: 'linear',
          display: true,
          position: 'right',
          title: { display: true, text: 'ความชื้น (%)', color: '#38bdf8' },
          ticks: { color: '#38bdf8' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

async function fetchHistoryData() {
  const houseSelect = document.getElementById('chart-house-select');
  const metricSelect = document.getElementById('chart-metric-select');
  if (!houseSelect) return;

  const houseId = houseSelect.value;
  const metric = metricSelect ? metricSelect.value : 'both';

  try {
    const res = await fetch(`/api/history?house=${houseId}&limit=25`);
    const data = await res.json();

    if (!historyChart) return;

    if (houseId === 'all') {
      renderAllHousesChart(data, metric);
    } else {
      renderSingleHouseChart(data, metric, houseId);
    }
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function renderSingleHouseChart(data, metric, houseId) {
  const houseNames = {
    house1: 'โรงเรือน 1',
    house2: 'โรงเรือน 2',
    house3: 'โรงเรือน 3'
  };
  const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString('th-TH'));
  const temps = data.map(d => d.temperature);
  const hums = data.map(d => d.humidity);

  const datasets = [];

  if (metric === 'both' || metric === 'temp') {
    datasets.push({
      label: `${houseNames[houseId] || houseId} - อุณหภูมิ (°C)`,
      data: temps,
      borderColor: '#f43f5e',
      backgroundColor: 'rgba(244, 63, 94, 0.1)',
      yAxisID: 'yTemp',
      tension: 0.3,
      fill: true
    });
  }

  if (metric === 'both' || metric === 'hum') {
    datasets.push({
      label: `${houseNames[houseId] || houseId} - ความชื้น (%)`,
      data: hums,
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56, 189, 248, 0.1)',
      yAxisID: 'yHum',
      tension: 0.3,
      fill: true
    });
  }

  historyChart.data.labels = labels;
  historyChart.data.datasets = datasets;
  historyChart.options.scales.yTemp.display = (metric === 'both' || metric === 'temp');
  historyChart.options.scales.yHum.display = (metric === 'both' || metric === 'hum');
  historyChart.update();
}

function renderAllHousesChart(data, metric) {
  // แยกข้อมูลตามแต่ละโรงเรือน
  const h1 = data.filter(d => d.house_id === 'house1');
  const h2 = data.filter(d => d.house_id === 'house2');
  const h3 = data.filter(d => d.house_id === 'house3');

  // ดึง label เวลาจากชุดข้อมูลที่มี
  const source = h1.length >= h2.length && h1.length >= h3.length ? h1 : (h2.length >= h3.length ? h2 : h3);
  const labels = source.map(d => new Date(d.timestamp).toLocaleTimeString('th-TH'));

  const datasets = [];

  // กราฟอุณหภูมิ (เปรียบเทียบ 3 โรงเรือน)
  if (metric === 'both' || metric === 'temp') {
    datasets.push({
      label: 'โรงเรือน 1 - อุณหภูมิ (°C)',
      data: h1.map(d => d.temperature),
      borderColor: '#f43f5e', // แดง/ชมพู
      backgroundColor: 'transparent',
      yAxisID: 'yTemp',
      tension: 0.3,
      pointRadius: 3
    });
    datasets.push({
      label: 'โรงเรือน 2 - อุณหภูมิ (°C)',
      data: h2.map(d => d.temperature),
      borderColor: '#0ea5e9', // ฟ้า
      backgroundColor: 'transparent',
      yAxisID: 'yTemp',
      tension: 0.3,
      pointRadius: 3
    });
    datasets.push({
      label: 'โรงเรือน 3 - อุณหภูมิ (°C)',
      data: h3.map(d => d.temperature),
      borderColor: '#10b981', // เขียว
      backgroundColor: 'transparent',
      yAxisID: 'yTemp',
      tension: 0.3,
      pointRadius: 3
    });
  }

  // กราฟความชื้น (เปรียบเทียบ 3 โรงเรือน เป็นเส้นประ)
  if (metric === 'both' || metric === 'hum') {
    datasets.push({
      label: 'โรงเรือน 1 - ความชื้น (%)',
      data: h1.map(d => d.humidity),
      borderColor: '#fb923c', // ส้ม
      backgroundColor: 'transparent',
      borderDash: [5, 5],
      yAxisID: 'yHum',
      tension: 0.3,
      pointRadius: 3
    });
    datasets.push({
      label: 'โรงเรือน 2 - ความชื้น (%)',
      data: h2.map(d => d.humidity),
      borderColor: '#8b5cf6', // ม่วง
      backgroundColor: 'transparent',
      borderDash: [5, 5],
      yAxisID: 'yHum',
      tension: 0.3,
      pointRadius: 3
    });
    datasets.push({
      label: 'โรงเรือน 3 - ความชื้น (%)',
      data: h3.map(d => d.humidity),
      borderColor: '#14b8a6', // เขียวอมฟ้า
      backgroundColor: 'transparent',
      borderDash: [5, 5],
      yAxisID: 'yHum',
      tension: 0.3,
      pointRadius: 3
    });
  }

  historyChart.data.labels = labels;
  historyChart.data.datasets = datasets;
  historyChart.options.scales.yTemp.display = (metric === 'both' || metric === 'temp');
  historyChart.options.scales.yHum.display = (metric === 'both' || metric === 'hum');
  historyChart.update();
}

// -----------------------------------------------------------------
// 7. AUTOMATION RULE ENGINE
// -----------------------------------------------------------------
async function fetchRules() {
  try {
    const res = await fetch('/api/rules');
    const rules = await res.json();
    const listEl = document.getElementById('rules-list');

    if (rules.length === 0) {
      listEl.innerHTML = `<div class="text-xs text-slate-500 dark:text-slate-400 text-center py-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-800">ยังไม่มี Rule ใดๆ — สร้างเงื่อนไขจากฟอร์มด้านบนเพื่อทดสอบโจทย์พิเศษได้เลย</div>`;
      return;
    }

    listEl.innerHTML = rules.map(r => `
      <div class="bg-white dark:bg-slate-900/80 p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center text-xs shadow-sm">
        <div class="flex items-center gap-3">
          <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
          <div>
            <strong class="text-slate-800 dark:text-white text-sm">${r.name}</strong>
            <span class="text-slate-500 dark:text-slate-400 ml-2">IF [${r.house_id}] ${r.metric} ${r.operator} ${r.threshold} → THEN Light: <b class="text-amber-500 dark:text-amber-400 font-bold">${r.action}</b></span>
          </div>
        </div>
        <button onclick="deleteRule(${r.id})" class="text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300 px-3 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/10 dark:hover:bg-rose-500/20 transition cursor-pointer font-medium">
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
    await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await fetch(`/api/rules/${id}`, { method: 'DELETE' });
    fetchRules();
  } catch (err) {
    alert('ลบไม่สำเร็จ');
  }
}
