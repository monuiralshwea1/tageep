// --- Database ---
const API_METHOD_BASE = '/api/method/tageep.api';
const API_ROUTES = {
    state: `${API_METHOD_BASE}.get_state`,
    saveState: `${API_METHOD_BASE}.save_state`,
    licenseStatus: `${API_METHOD_BASE}.license_status`,
    activateLicense: `${API_METHOD_BASE}.activate_license`,
    login: `${API_METHOD_BASE}.login`
};
let backendAvailable = false;
let isSavingRemote = false;

let db = {
    settings: { companyName: 'الشركة', logo: '', weeklyOffDays: ['5'], operationalDayStart: '06:00' },
    branches: [{ id: 'b1', name: 'المركز الرئيسي' }],
    users: [],
    employees: [],
    absences: [], // {id, empId, date, value, type:'absent'|'annual'|'holiday_present'}
    dailyFollowUps: [], // {id, empId, branchId, date, statusType, value, notes, createdAt}
    dailyExtras: [], // {id, empId, date, amount, notes, createdAt}
    archivedReports: [], // {id, branchId, branchName, date, createdAt, entries, fileName}
    holidays: [], // {id, name, date}
    workShifts: [] // {id, name, periods: [{id, name, startTime, endTime}]}
};

function normalizeAppState(data) {
    db = {
        settings: data.settings || { companyName: 'الشركة', logo: '', weeklyOffDays: ['5'], operationalDayStart: '06:00' },
        branches: data.branches || [],
        users: (data.users || []).map(user => ({
            ...user,
            password: user.password || ''
        })),
        employees: (data.employees || []).map(emp => ({
            ...emp,
            employeeNumber: emp.employeeNumber || emp.employee_number || '',
            wage: parseFloat(emp.wage) || 0,
            leaveBalance: parseFloat(emp.leaveBalance) || 0
        })),
        absences: (data.absences || []).map(item => ({
            ...item,
            value: parseFloat(item.value) || 1
        })),
        dailyFollowUps: (data.dailyFollowUps || []).map(item => ({
            ...item,
            value: parseFloat(item.value) || 1
        })),
        dailyExtras: (data.dailyExtras || []).map(item => ({
            ...item,
            amount: parseFloat(item.amount) || 0
        })),
        archivedReports: data.archivedReports || [],
        holidays: data.holidays || [],
        workShifts: (data.workShifts || []).map(shift => ({
            id: shift.id || `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
            name: shift.name || '',
            periods: (shift.periods || []).map(period => ({
                id: period.id || `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
                name: period.name || '',
                startTime: period.startTime || '00:00',
                endTime: period.endTime || '00:00'
            }))
        }))
    };
}

function getAccessToken() {
    return localStorage.getItem('appAccessToken') || '';
}

function getCsrfToken() {
    return (window.frappe && window.frappe.csrf_token) || '';
}

function stripHtml(value) {
    return String(value || '').replace(/<[^>]*>/g, '').trim();
}

// Helpers: normalize text, find employee, format employee label, and save DB
function normalizeText(text) {
    if (text === null || text === undefined) return '';
    try {
        return String(text)
            .normalize('NFKD')
            .replace(/[\u064B-\u0652]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    } catch (e) {
        return String(text).trim().toLowerCase();
    }
}

function findEmployeeById(id) {
    if (!id) return null;
    return (db.employees || []).find(e => e.id === id) || null;
}

function getEmployeeLabel(id) {
    const emp = findEmployeeById(id);
    if (!emp) return id || '';
    return `${emp.name || ''}${emp.employeeNumber ? ' (' + emp.employeeNumber + ')' : ''}`;
}

// Enhanced saveDB with auto-refresh
function saveDB() {
    try {
        localStorage.setItem('tageep_state', JSON.stringify(db));
    } catch (e) {
        console.warn('saveDB: local save failed', e);
    }
    // Try to persist to remote in background; don't block UI
    persistRemoteState().catch(err => { console.warn('saveDB: remote persist failed', err); });
    // Auto-refresh the current view immediately
    refreshCurrentView();
}

// دالة لتحديث الواجهة الحالية تلقائياً بعد الحفظ
function refreshCurrentView() {
    const activeTab = document.querySelector('.tab-content.active');
    if (!activeTab) return;
    const activeId = activeTab.id;
    
    // Update all dropdowns to reflect new data
    refreshAllDropdowns();
    
    // Refresh tables based on active tab
    switch (activeId) {
        case 'tab-main':
            renderMainTable();
            // Also refresh report in case
            renderReportTable();
            break;
        case 'tab-daily':
            renderDailyFollowups();
            renderDailyExtras();
            break;
        case 'tab-employees':
            renderEmployees();
            break;
        case 'tab-branches':
            renderBranches();
            break;
        case 'tab-users':
            renderUsers();
            break;
        case 'tab-settings':
            renderHolidays();
            renderWorkShifts();
            renderShiftPeriods();
            break;
    }
}

// تحديث جميع القوائم المنسدلة
function refreshAllDropdowns() {
    // Employee selects
    const empSelects = [
        document.getElementById('dailyEmp'),
        document.getElementById('dailyFilterEmp'),
        document.getElementById('extraEmp'),
        document.getElementById('extraFilterEmp')
    ];
    empSelects.forEach(select => {
        if (!select) return;
        const savedValue = select.value;
        const isFilter = select.id.includes('Filter');
        select.innerHTML = isFilter ? '<option value="all">الكل</option>' : '<option value="">اختر موظفاً</option>';
        db.employees.forEach(e => {
            select.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        // Restore value if still valid
        if (savedValue && db.employees.find(e => e.id === savedValue)) {
            select.value = savedValue;
        }
    });
    
    // Branch selects
    const branchSelects = [
        document.getElementById('empBranch'),
        document.getElementById('empFilterBranch'),
        document.getElementById('filterBranch'),
        document.getElementById('userBranch'),
        document.getElementById('dailyBranch'),
        document.getElementById('dailyFilterBranch'),
        document.getElementById('archiveFilterBranch'),
        document.getElementById('reportBranch')
    ];
    branchSelects.forEach(select => {
        if (!select) return;
        const savedValue = select.value;
        const isFilter = select.id === 'filterBranch' || select.id === 'userBranch' || select.id === 'dailyFilterBranch' || select.id === 'archiveFilterBranch' || select.id === 'reportBranch' || select.id === 'empFilterBranch';
        select.innerHTML = isFilter ? '<option value="all">الكل</option>' : '';
        db.branches.forEach(b => {
            select.innerHTML += `<option value="${b.id}">${b.name}</option>`;
        });
        if (savedValue && db.branches.find(b => b.id === savedValue)) {
            select.value = savedValue;
        }
    });
    
    // Report shift dropdown
    const reportShift = document.getElementById('reportShift');
    if (reportShift) {
        reportShift.innerHTML = '<option value="all">الكل</option>' + 
            db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        renderReportPeriodFilter();
    }
}

// Count work days between two dates (inclusive), excluding configured weekly off days
function countWorkDays(from, to) {
    if (!from || !to) return 0;
    const a = new Date(from); const b = new Date(to);
    let count = 0;
    const offDays = Array.isArray(db.settings.weeklyOffDays)
        ? db.settings.weeklyOffDays.map(v => parseInt(v, 10))
        : [parseInt(db.settings.weeklyOffDay || '5', 10)];
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
        if (offDays.includes(d.getDay())) continue;
        count++;
    }
    return count;
}

function getHolidaysBetween(from, to) {
    if (!from || !to) return [];
    return (db.holidays || []).filter(h => h.date >= from && h.date <= to).map(h => h.date);
}

// Return array of working dates between two dates (inclusive), excluding weekly off days
function getWorkingDatesBetween(from, to, limit = null) {
    const dates = [];
    if (!from || !to) return dates;
    const a = new Date(from); const b = new Date(to);
    const offDays = Array.isArray(db.settings.weeklyOffDays)
        ? db.settings.weeklyOffDays.map(v => parseInt(v, 10))
        : [parseInt(db.settings.weeklyOffDay || '5', 10)];
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
        if (offDays.includes(d.getDay())) continue;
        dates.push(d.toISOString().split('T')[0]);
        if (limit && dates.length >= limit) break;
    }
    return dates;
}

function populateDailyPeriodOptions(empId) {
    const emp = db.employees.find(e => e.id === empId);
    const shift = emp ? db.workShifts.find(s => s.id === emp.shiftId) : null;
    let periodEl = document.getElementById('dailyPeriod');
    const existingValueEl = document.getElementById('dailyValue');
    const container = document.getElementById('dailyPeriodContainer') || (existingValueEl ? existingValueEl.parentElement : null);
    if (!periodEl) {
        periodEl = document.createElement('select');
        periodEl.id = 'dailyPeriod';
        periodEl.style.minWidth = '120px';
        if (container) {
            if (existingValueEl && existingValueEl.parentElement === container) {
                container.insertBefore(periodEl, existingValueEl.nextSibling);
            } else {
                container.appendChild(periodEl);
            }
        } else {
            const form = document.querySelector('form') || document.body;
            form.appendChild(periodEl);
        }
    }
    periodEl.innerHTML = '<option value="all">الكل</option>';
    if (shift && Array.isArray(shift.periods) && shift.periods.length) {
        shift.periods.forEach(p => { periodEl.innerHTML += `<option value="${p.id}">${p.name}</option>`; });
        periodEl.disabled = false;
    } else {
        periodEl.disabled = true;
    }
    if (existingValueEl) existingValueEl.style.display = 'none';
}

function getShiftPeriodIdsForEmployee(emp) {
    if (!emp) return ['all'];
    const shift = db.workShifts.find(s => s.id === emp.shiftId);
    if (!shift || !Array.isArray(shift.periods) || shift.periods.length === 0) return ['all'];
    return shift.periods.map(p => p.id);
}

function getPeriodsCountForEmployee(emp) {
    return getShiftPeriodIdsForEmployee(emp).length || 1;
}

// return array of status per period for emp on given date
function getDailyStatusArray(emp, date) {
    const periodIds = getShiftPeriodIdsForEmployee(emp);
    const N = periodIds.length;
    const status = Array(N).fill('present');
    const mainRec = (db.absences || []).find(a => a.empId === emp.id && a.date === date);
    if (mainRec) {
        const t = mainRec.type;
        if (t === 'holiday_present') {
            for (let i = 0; i < N; i++) status[i] = 'holiday_present';
        } else {
            for (let i = 0; i < N; i++) status[i] = t;
        }
        return status;
    }
    const entries = (db.dailyFollowUps || []).filter(x => x.empId === emp.id && x.date === date);
    if (!entries.length) return status;
    entries.forEach(entry => {
        if (!entry.period || entry.period === 'all') {
            for (let i = 0; i < N; i++) status[i] = entry.statusType;
        } else {
            const idx = periodIds.indexOf(entry.period);
            if (idx !== -1) status[idx] = entry.statusType;
        }
    });
    return status;
}

function getAbsenceTotalsForEmployee(emp, from, to) {
    const workingDates = getWorkingDatesBetween(from, to);
    let absenceDays = 0;
    let annualDays = 0;
    let holidayPresent = 0;
    const holidaysSet = new Set((db.holidays || []).filter(h => h.date >= from && h.date <= to).map(h => h.date));
    workingDates.forEach(date => {
        const mainRec = (db.absences || []).find(a => a.empId === emp.id && a.date === date);
        if (holidaysSet.has(date)) {
            if (mainRec) {
                const val = parseFloat(mainRec.value) || 0;
                if (mainRec.type === 'absent' || mainRec.type === 'annual') absenceDays += val;
                if (mainRec.type === 'annual') annualDays += val;
            } else {
                holidayPresent += 1;
            }
            return;
        }
        if (mainRec) {
            const val = parseFloat(mainRec.value) || 0;
            if (mainRec.type === 'absent' || mainRec.type === 'annual') absenceDays += val;
            if (mainRec.type === 'annual') annualDays += val;
            return;
        }
        const statusArr = getDailyStatusArray(emp, date);
        const N = statusArr.length || 1;
        let absentCount = 0; let annualCount = 0;
        statusArr.forEach(s => {
            if (s === 'absent') absentCount++;
            if (s === 'annual') annualCount++;
        });
        absenceDays += (absentCount + annualCount) / N;
        annualDays += annualCount / N;
    });
    return { absenceDays, annualDays, holidayPresent };
}

function getApiErrorMessage(data, fallback) {
    if (data && data._server_messages) {
        try {
            return JSON.parse(data._server_messages)
                .map(item => stripHtml(JSON.parse(item).message || item))
                .filter(Boolean)
                .join('\n') || fallback;
        } catch (error) {
            return fallback;
        }
    }
    if (data && typeof data.message === 'string') return stripHtml(data.message) || fallback;
    if (data && data.exception) return stripHtml(data.exception) || fallback;
    return fallback;
}

function buildApiHeaders(options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.json !== false) headers['Content-Type'] = 'application/json';
    const token = getAccessToken();
    if (options.auth !== false && token) headers['X-Tageep-Token'] = token;
    const csrfToken = getCsrfToken();
    if (csrfToken && options.method && options.method !== 'GET') {
        headers['X-Frappe-CSRF-Token'] = csrfToken;
    }
    return headers;
}

async function parseApiResponse(response) {
    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }
    if (!response.ok) {
        throw new Error(getApiErrorMessage(data, response.statusText || 'API Error'));
    }
    return Object.prototype.hasOwnProperty.call(data, 'message') ? data.message : data;
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: buildApiHeaders(options) });
    return parseApiResponse(response);
}

async function loadRemoteState() {
    normalizeAppState(await apiRequest(API_ROUTES.state, { method: 'GET' }));
    backendAvailable = true;
}

async function persistRemoteState() {
    if (isSavingRemote) return;
    isSavingRemote = true;
    try {
        const state = await apiRequest(API_ROUTES.saveState, {
            method: 'POST',
            body: JSON.stringify({ state: db })
        });
        normalizeAppState(state);
        backendAvailable = true;
        console.info('State persisted to backend successfully.');
    } catch (error) {
        backendAvailable = false;
        console.warn('API save failed:', error);
        if (getAccessToken()) {
            alert(`تعذر حفظ البيانات في قاعدة بيانات Frappe.\n${error.message || ''}`);
        }
    } finally {
        isSavingRemote = false;
    }
}

async function getLicenseStatus() {
    return apiRequest(API_ROUTES.licenseStatus, { method: 'GET', auth: false });
}

function showLicense(message) {
    document.getElementById('licenseMessage').innerText = message || '';
    document.getElementById('licenseScreen').style.display = 'flex';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appRoot').style.display = 'none';
}

async function activateLicense() {
    const code = document.getElementById('licenseCode').value.trim();
    if (!code) return showLicense('يرجى إدخال رمز الترخيص');
    try {
        const status = await apiRequest(API_ROUTES.activateLicense, {
            method: 'POST',
            auth: false,
            body: JSON.stringify({ code })
        });
        if (!status.active) return showLicense(status.message || 'لم يتم تفعيل الترخيص');
        document.getElementById('licenseCode').value = '';
        loadLoginState();
        showLogin('تم تفعيل النظام بنجاح. يمكنك تسجيل الدخول الآن.');
    } catch (error) {
        console.error('License activation error:', error);
        showLicense(`تعذر تفعيل الترخيص من باكند Frappe. ${error.message || ''}`);
    }
}


// === مكون القائمة المنسدلة القابلة للبحث (Searchable Select) ===
// يقوم بتحويل select عادي إلى حقل يمكن البحث فيه بالكتابة
function makeSelectSearchable(selectEl, placeholderText) {
    if (!selectEl || selectEl.dataset.searchable === 'true') return;
    selectEl.dataset.searchable = 'true';
    
    // حفظ قيمة الـ select الأصلية للرجوع إليها
    selectEl.setAttribute('data-original-display', selectEl.style.display || '');
    
    // إنشاء الحاوية
    const container = document.createElement('div');
    container.className = 'searchable-select-container';
    container.style.cssText = 'position:relative;display:inline-block;width:100%;min-width:150px;';
    
    // حقل الإدخال
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'searchable-select-input';
    input.placeholder = placeholderText || 'ابحث...';
    input.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;background:#fff;';
    
    // القائمة المنسدلة للنتائج
    const dropdown = document.createElement('div');
    dropdown.className = 'searchable-select-dropdown';
    dropdown.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ccc;border-top:none;max-height:200px;overflow-y:auto;z-index:1000;border-radius:0 0 4px 4px;box-shadow:0 4px 8px rgba(0,0,0,0.1);';
    
    // إخفاء الـ select الأصلي
    selectEl.style.display = 'none';
    selectEl.parentNode.insertBefore(container, selectEl);
    container.appendChild(input);
    container.appendChild(dropdown);
    container.appendChild(selectEl); // نقل الـ select داخل الحاوية

    // دالة اختيار عنصر
    function selectItem(value, text) {
        selectEl.value = value;
        input.value = text;
        dropdown.style.display = 'none';
        // Trigger change event
        if (typeof jQuery !== 'undefined') {
            jQuery(selectEl).trigger('change');
        } else {
            const evt = new Event('change', { bubbles: true });
            selectEl.dispatchEvent(evt);
        }
    }

    // تحديث القائمة
    function updateDropdown(filterText) {
        const filter = normalizeText(filterText || '');
        dropdown.innerHTML = '';
        let hasResults = false;
        
        Array.from(selectEl.options).forEach(opt => {
            if (!opt.value) return;
            const text = opt.text || '';
            const labelEl = document.createElement('div');
            labelEl.className = 'searchable-select-item';
            labelEl.style.cssText = 'padding:8px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;transition:background 0.15s;';
            labelEl.textContent = text;
            const val = opt.value;
            
            // تطبيق الفلتر
            if (!filter || normalizeText(text).includes(filter)) {
                hasResults = true;
                labelEl.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    selectItem(val, text);
                });
                labelEl.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                    selectItem(val, text);
                });
                labelEl.addEventListener('mouseenter', function() {
                    this.style.background = '#e8f0fe';
                });
                labelEl.addEventListener('mouseleave', function() {
                    this.style.background = '#fff';
                });
                dropdown.appendChild(labelEl);
            }
        });
        
        if (!hasResults) {
            const noResults = document.createElement('div');
            noResults.style.cssText = 'padding:8px 10px;color:#999;font-size:12px;text-align:center;';
            noResults.textContent = 'لا توجد نتائج';
            dropdown.appendChild(noResults);
        }
    }

    // إظهار القائمة عند التركيز على حقل الإدخال
    input.addEventListener('focus', function() {
        const selectedOpt = selectEl.options[selectEl.selectedIndex];
        if (selectedOpt && selectedOpt.value) {
            input.value = selectedOpt.text;
        } else {
            input.value = '';
        }
        dropdown.style.display = 'block';
        updateDropdown(input.value);
    });

    // الفلتر أثناء الكتابة
    input.addEventListener('input', function() {
        dropdown.style.display = 'block';
        updateDropdown(this.value);
    });

    // إخفاء القائمة عند فقدان التركيز
    input.addEventListener('blur', function() {
        setTimeout(() => {
            dropdown.style.display = 'none';
            const selectedOpt = selectEl.options[selectEl.selectedIndex];
            if (selectedOpt && selectedOpt.value) {
                input.value = selectedOpt.text;
            }
        }, 300);
    });

    // مفتاح ESC لإغلاق القائمة
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            dropdown.style.display = 'none';
        }
        if (e.key === 'Enter') {
            const firstItem = dropdown.querySelector('.searchable-select-item');
            if (firstItem) {
                firstItem.click();
            }
        }
    });

    // تحديث القائمة عند تغيير الـ select من الخارج
    selectEl.addEventListener('change', function() {
        const selectedOpt = this.options[this.selectedIndex];
        if (selectedOpt && selectedOpt.value) {
            input.value = selectedOpt.text;
        } else {
            input.value = '';
        }
    });

    // تهيئة أولية
    const savedOpt = selectEl.options[selectEl.selectedIndex];
    if (savedOpt && savedOpt.value) {
        input.value = savedOpt.text;
    }
}

// تفعيل خاصية البحث في جميع القوائم المهمة
function enableSearchableSelects() {
    const selectIds = [
        'filterBranch', 'dailyBranch', 'dailyFilterBranch', 'archiveFilterBranch', 
        'empBranch', 'empFilterBranch', 'reportBranch', 'userBranch',
        'dailyEmp', 'dailyFilterEmp', 'extraEmp', 'extraFilterEmp',
        'empShift', 'reportShift', 'reportPeriod',
        'selectedShiftSelect'
    ];
    selectIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const placeholder = el.tagName === 'SELECT' ? 
                (el.options[0]?.text || 'ابحث...') : 'ابحث...';
            makeSelectSearchable(el, placeholder);
        }
    });
}


// === وظيفة الطباعة ===
window.openPrintPreview = function () {
    try {
        let activeTab = document.querySelector('.tab-content.active');
        let table = activeTab ? activeTab.querySelector('table') : null;
        if (!table) {
            const wrappers = Array.from(document.querySelectorAll('.table-wrapper'));
            for (const w of wrappers) {
                const style = window.getComputedStyle(w);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    const t = w.querySelector('table');
                    if (t) { table = t; break; }
                }
            }
        }
        if (!table) {
            alert('لا توجد جداول للطباعة في الواجهة الحالية');
            return;
        }
        
        const savedPaperSize = localStorage.getItem('tageep_paper_size') || 'A4';
        document.getElementById('previewPaperSize').value = savedPaperSize;
        
        document.getElementById('printPreviewModal').style.display = 'block';
        updatePrintPreview();
    } catch (err) {
        console.error('openPrintPreview error:', err);
    }
};

window.closePrintPreview = function () {
    document.getElementById('printPreviewModal').style.display = 'none';
};

window.updatePrintPreview = function () {
    try {
        const paperSize = document.getElementById('previewPaperSize').value;
        const orientation = document.getElementById('previewOrientation').value;
        
        localStorage.setItem('tageep_paper_size', paperSize);
        localStorage.setItem('tageep_orientation', orientation);
        
        let activeTab = document.querySelector('.tab-content.active');
        let table = activeTab ? activeTab.querySelector('table') : null;
        if (!table) {
            const wrappers = Array.from(document.querySelectorAll('.table-wrapper'));
            for (const w of wrappers) {
                const style = window.getComputedStyle(w);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    const t = w.querySelector('table');
                    if (t) { table = t; break; }
                }
            }
        }
        if (!table) return;
        
        const companyName = db.settings.companyName || '';
        const logoUrl = db.settings.logo || '';
        const dateRangeEl = document.getElementById('printDateRange');
        const dateRangeText = dateRangeEl ? dateRangeEl.innerText : '';
        
        const tableClone = table.cloneNode(true);
        const rows = tableClone.querySelectorAll('tr');
        rows.forEach(row => {
            const lastCell = row.querySelector('td:last-child, th:last-child');
            if (lastCell && lastCell.classList.contains('no-print')) {
                lastCell.remove();
            }
        });
        
        const firstRow = tableClone.querySelector('tr');
        const colCount = firstRow ? firstRow.cells.length : 1;
        
        const originalThead = tableClone.querySelector('thead');
        let columnHeadersHtml = '';
        if (originalThead) {
            columnHeadersHtml = originalThead.querySelector('tr').outerHTML;
        }
        
        const logoHtml = logoUrl
            ? `<img src="${logoUrl}" style="width:100%;height:auto;object-fit:fill;display:block;margin:0;padding:0;" alt="شعار الشركة">`
            : '';
        const headerRowHtml = `<tr style="display:table-row;">
            <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
                ${logoHtml}
                <div style="font-size:14px;font-weight:bold;margin:2px 0;">كشف تعقيب الموظفين</div>
                <div style="font-size:11px;color:#666;margin-bottom:3px;">${dateRangeText}</div>
            </td>
        </tr>`;
        
        const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;
        
        const tableHtml = tableClone.outerHTML;
        const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);
        
        const paperSizeStyles = {
            'A4': { width: '210mm', height: '297mm' },
            'A5': { width: '148mm', height: '210mm' },
            'Letter': { width: '216mm', height: '279mm' },
            'Legal': { width: '216mm', height: '356mm' }
        };
        
        const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
        
        const isPortrait = orientation === 'portrait';
        const fontSize = isPortrait ? '7px' : '10px';
        const cellPadding = isPortrait ? '1.5px 2px' : '4px 5px';
        const headerFontSize = isPortrait ? '9px' : '11px';
        
        const printStyles = `
            <style>
                @page { 
                    size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; 
                    margin: 8mm; 
                }
                body { 
                    font-family: 'Segoe UI', Tahoma, Arial, sans-serif; 
                    direction: rtl; 
                    margin: 0; 
                    padding: 0; 
                }
                table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    font-size: ${fontSize};
                }
                th, td { 
                    padding: ${cellPadding}; 
                    text-align: center; 
                    border: 1px solid #000;
                    word-break: keep-all;
                }
                th { 
                    background-color: #dcedc8; 
                    font-weight: bold;
                    font-size: ${headerFontSize};
                }
                thead { 
                    display: table-header-group; 
                }
                thead th, thead td { 
                    position: static !important; 
                }
                thead img {
                    max-height: 40px !important;
                }
                tr { 
                    page-break-inside: auto; 
                    break-inside: auto; 
                }
                tbody tr { 
                    orphans: 2; 
                    widows: 2; 
                }
            </style>
        `;
        
        const previewContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>معاينة الطباعة - تقرير التعقيب</title>
    ${printStyles}
</head>
<body>
    ${finalHtml}
</body>
</html>`;
        
        const previewFrame = document.createElement('iframe');
        previewFrame.style.width = '100%';
        previewFrame.style.height = '600px';
        previewFrame.style.border = 'none';
        
        const previewContentDiv = document.getElementById('printPreviewContent');
        previewContentDiv.innerHTML = '';
        previewContentDiv.appendChild(previewFrame);
        
        const iframeDoc = previewFrame.contentDocument || previewFrame.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(previewContent);
        iframeDoc.close();
        
        setTimeout(() => {
            try {
                const iframeBody = previewFrame.contentDocument.body;
                const iframeHeight = iframeBody.scrollHeight;
                const pageHeight = parseInt(selectedSize.height);
                const pageCount = Math.ceil(iframeHeight / (pageHeight - 20));
                document.getElementById('pageCount').innerText = `عدد الصفحات: ${pageCount}`;
            } catch (e) {
                console.error('Error calculating page count:', e);
                document.getElementById('pageCount').innerText = 'عدد الصفحات: غير متاح';
            }
        }, 1000);
        
    } catch (err) {
        console.error('updatePrintPreview error:', err);
    }
};

window.printFromPreview = function () {
    try {
        const previewFrame = document.querySelector('#printPreviewContent iframe');
        if (previewFrame) {
            previewFrame.contentWindow.print();
        }
    } catch (err) {
        console.error('printFromPreview error:', err);
    }
};

window.printVisibleTable = function () {
    try {
        let activeTab = document.querySelector('.tab-content.active');
        let table = activeTab ? activeTab.querySelector('table') : null;
        if (!table) {
            const wrappers = Array.from(document.querySelectorAll('.table-wrapper'));
            for (const w of wrappers) {
                const style = window.getComputedStyle(w);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    const t = w.querySelector('table');
                    if (t) { table = t; break; }
                }
            }
        }
        if (!table) {
            alert('لا توجد جداول للطباعة في الواجهة الحالية');
            return;
        }

        const companyName = db.settings.companyName || '';
        const logoUrl = db.settings.logo || '';
        const dateRangeEl = document.getElementById('printDateRange');
        const dateRangeText = dateRangeEl ? dateRangeEl.innerText : '';

        const tableClone = table.cloneNode(true);
        const rows = tableClone.querySelectorAll('tr');
        rows.forEach(row => {
            const lastCell = row.querySelector('td:last-child, th:last-child');
            if (lastCell && lastCell.classList.contains('no-print')) {
                lastCell.remove();
            }
        });

        const firstRow = tableClone.querySelector('tr');
        const colCount = firstRow ? firstRow.cells.length : 1;

        const originalThead = tableClone.querySelector('thead');
        let columnHeadersHtml = '';
        if (originalThead) {
            columnHeadersHtml = originalThead.querySelector('tr').outerHTML;
        }

        const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
        const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

        const logoHtml = logoUrl
            ? `<img src="${logoUrl}" style="width:100%;height:auto;object-fit:fill;display:block;margin:0;padding:0;" alt="شعار الشركة">`
            : '';
        const headerRowHtml = `<tr style="display:table-row;">
            <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
                ${logoHtml}
                <div style="font-size:14px;font-weight:bold;margin:2px 0;">كشف تعقيب الموظفين</div>
                <div style="font-size:11px;color:#666;margin-bottom:3px;">${dateRangeText}</div>
            </td>
        </tr>`;

        const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;

        const paperSizeStyles = {
            'A4': { width: '210mm', height: '297mm' },
            'A5': { width: '148mm', height: '210mm' },
            'Letter': { width: '216mm', height: '279mm' },
            'Legal': { width: '216mm', height: '356mm' }
        };
        const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];

        const isPortrait = orientation === 'portrait';
        const fontSize = isPortrait ? '7px' : '10px';
        const cellPadding = isPortrait ? '1.5px 2px' : '4px 5px';
        const headerFontSize = isPortrait ? '9px' : '11px';

        const printStyles = `
            <style>
                @page { 
                    size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; 
                    margin: 8mm; 
                }
                body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
                table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
                th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
                th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
                thead { display: table-header-group; }
                thead th, thead td { position: static !important; }
                thead img { max-height: 40px !important; }
                tr { page-break-inside: auto; break-inside: auto; }
                tbody tr { orphans: 2; widows: 2; }
            </style>
        `;

        const tableHtml = tableClone.outerHTML;
        const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>طباعة - تقرير التعقيب</title>
    ${printStyles}
</head>
<body>
    ${finalHtml}
</body>
</html>`;

        const printWindow = window.open('', '_blank', 'width=1024,height=768');
        if (!printWindow) {
            const printFrame = document.createElement('iframe');
            printFrame.style.position = 'fixed';
            printFrame.style.top = '-9999px';
            printFrame.style.left = '-9999px';
            printFrame.style.width = '0';
            printFrame.style.height = '0';
            document.body.appendChild(printFrame);
            
            const iframeDoc = printFrame.contentDocument || printFrame.contentWindow.document;
            iframeDoc.open();
            iframeDoc.write(printContent);
            iframeDoc.close();
            
            setTimeout(() => {
                try {
                    printFrame.contentWindow.print();
                } catch(e) {
                    console.error('iframe print error:', e);
                    window.print();
                }
                setTimeout(() => {
                    document.body.removeChild(printFrame);
                }, 1000);
            }, 500);
            return;
        }
        
        printWindow.document.open();
        printWindow.document.write(printContent);
        printWindow.document.close();
        
        printWindow.onload = function() {
            setTimeout(() => {
                printWindow.print();
            }, 500);
        };
        setTimeout(() => {
            printWindow.print();
        }, 1000);
        
    } catch (err) {
        console.error('printVisibleTable error:', err);
        window.print();
    }
};

// Normalize stored user objects
db.users = (db.users || []).map(user => ({
    id: user.id || 'u' + Date.now(),
    name: (user.name || user.username || '').toString().trim(),
    password: typeof user.password === 'string' ? user.password : typeof user.userPassword === 'string' ? user.userPassword : '',
    role: user.role || 'admin',
    branchId: user.branchId || user.userBranch || 'all',
    allowedTabs: user.allowedTabs || {},
    tabPermissions: user.tabPermissions || {}
}));

let currentUser = null;

const defaultAllowedTabs = {
    main: true,
    daily: true,
    archive: true,
    employees: true,
    branches: true,
    users: true,
    settings: true
};

function getUserAllowedTabs(user) {
    if (!user || user.role === 'admin') return { ...defaultAllowedTabs };
    return { ...defaultAllowedTabs, ...(user.allowedTabs || {}) };
}

function getUserPermissionLevel(user, tab) {
    if (!user || user.role === 'admin') return 'all';
    return (user.tabPermissions && user.tabPermissions[tab]) || 'all';
}

function canViewTab(tab) {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    return !!getUserAllowedTabs(currentUser)[tab];
}

function canPerform(tab, action) {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    const level = getUserPermissionLevel(currentUser, tab);
    if (action === 'view') return level !== 'none';
    if (action === 'add') return ['all', 'add'].includes(level);
    if (action === 'edit') return ['all', 'edit'].includes(level);
    if (action === 'delete') return ['all', 'delete'].includes(level);
    return level === 'all';
}

function getTabLabel(key) {
    switch (key) {
        case 'main': return 'التعقيب الرئيسي';
        case 'daily': return 'التعقيب اليومي';
        case 'archive': return 'أرشفة التعقيب';
        case 'employees': return 'الموظفين';
        case 'branches': return 'الفروع';
        case 'users': return 'المستخدمين';
        case 'settings': return 'الإعدادات';
        default: return key;
    }
}

function formatUserTabs(user) {
    if (!user) return '';
    if (user.role === 'admin') return 'الكل';
    return Object.keys(getUserAllowedTabs(user)).filter(tab => getUserAllowedTabs(user)[tab]).map(getTabLabel).join(', ');
}

function formatUserPermissions(user) {
    if (!user) return '';
    if (user.role === 'admin') return 'الكل';
    const items = Object.keys(defaultAllowedTabs).map(tab => {
        const level = getUserPermissionLevel(user, tab);
        return `${getTabLabel(tab)}: ${level === 'none' ? 'بدون' : level === 'view' ? 'عرض فقط' : level === 'add' ? 'إضافة' : level === 'edit' ? 'تعديل' : level === 'delete' ? 'حذف' : 'الكل'}`;
    });
    return items.join(' | ');
}

// --- Init & Defaults ---
function initDates() {
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - 6);

    document.getElementById('filterTo').value = today.toISOString().split('T')[0];
    document.getElementById('filterFrom').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('empDate').value = today.toISOString().split('T')[0];
    document.getElementById('dailyDate').value = today.toISOString().split('T')[0];
    document.getElementById('extraDate').value = today.toISOString().split('T')[0];
    document.getElementById('dailyFilterTo').value = today.toISOString().split('T')[0];
    document.getElementById('dailyFilterFrom').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('extraFilterTo').value = today.toISOString().split('T')[0];
    document.getElementById('extraFilterFrom').value = lastWeek.toISOString().split('T')[0];
    const reportFrom = document.getElementById('reportFrom');
    const reportTo = document.getElementById('reportTo');
    if (reportFrom) reportFrom.value = lastWeek.toISOString().split('T')[0];
    if (reportTo) reportTo.value = today.toISOString().split('T')[0];
}

function switchMainPanel(panelId) {
    document.querySelectorAll('.main-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.sub-tab-btn').forEach(btn => btn.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.sub-tab-btn[data-main-panel="${panelId}"]`);
    if (btn) btn.classList.add('active');
    if (panelId === 'attendance-panel') {
        renderMainTable();
    } else if (panelId === 'report-panel') {
        renderReportTable();
    }
}

function addOrReplaceAbsenceRecord(newRec) {
    const emp = findEmployeeById(newRec.empId);
    const existing = db.absences.find(a => a.empId === newRec.empId && a.date === newRec.date);
    if (existing) {
        if (existing.type === 'annual' && emp) {
            emp.leaveBalance = parseFloat(emp.leaveBalance) + parseFloat(existing.value);
        }
        db.absences = db.absences.filter(a => !(a.empId === newRec.empId && a.date === newRec.date));
    }
    if (newRec.type === 'annual' && emp) {
        emp.leaveBalance = parseFloat(emp.leaveBalance) - parseFloat(newRec.value);
    }
    db.absences.push(newRec);
}

function renderAll() {
    // Apply Settings
    document.getElementById('displayCompanyName').innerText = db.settings.companyName;
    document.getElementById('settingsCompanyName').value = db.settings.companyName;
    const settingsLogoEl = document.getElementById('settingsLogo');
    if (settingsLogoEl) settingsLogoEl.value = db.settings.logo;
    enhanceSettingsLogoInput();
    document.getElementById('settingsOperationalDayStart').value = db.settings.operationalDayStart || '06:00';
    const weeklyOffDays = Array.isArray(db.settings.weeklyOffDays)
        ? db.settings.weeklyOffDays
        : [db.settings.weeklyOffDay || '5'];
    Array.from(document.querySelectorAll('#settingsWeeklyOff input[type=checkbox]')).forEach(checkbox => {
        checkbox.checked = weeklyOffDays.includes(checkbox.value);
    });
    document.getElementById('printLogo').src = db.settings.logo;

    // Populate all dropdowns
    const branchSelects = [
        document.getElementById('empBranch'),
        document.getElementById('empFilterBranch'),
        document.getElementById('filterBranch'),
        document.getElementById('userBranch'),
        document.getElementById('dailyBranch'),
        document.getElementById('dailyFilterBranch'),
        document.getElementById('archiveFilterBranch')
    ];
    branchSelects.forEach(select => {
        const isFilter = select.id === 'filterBranch' || select.id === 'userBranch' || select.id === 'dailyFilterBranch' || select.id === 'archiveFilterBranch';
        select.innerHTML = isFilter ? '<option value="all">الكل</option>' : '';
        db.branches.forEach(b => select.innerHTML += `<option value="${b.id}">${b.name}</option>`);
    });

    const empShiftSelect = document.getElementById('empShift');
    if (empShiftSelect) {
        const shiftOptions = db.workShifts.length
            ? db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('')
            : '<option value="" disabled>لا يوجد دوامات</option>';
        const placeholder = '<option value="" disabled selected>اختر الدوام</option>';
        empShiftSelect.innerHTML = placeholder + shiftOptions;
        empShiftSelect.disabled = db.workShifts.length === 0;
    }

    document.getElementById('dailyEmp').innerHTML = `<option value="">اختر موظفاً</option>` + db.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    const dailyEmpEl = document.getElementById('dailyEmp');
    if (dailyEmpEl) {
        dailyEmpEl.onchange = function () { populateDailyPeriodOptions(this.value); };
    }
    document.getElementById('dailyFilterEmp').innerHTML = `<option value="all">الكل</option>` + db.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    document.getElementById('extraEmp').innerHTML = `<option value="">اختر موظفاً</option>` + db.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    document.getElementById('extraFilterEmp').innerHTML = `<option value="all">الكل</option>` + db.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    document.getElementById('empFilterBranch').innerHTML = `<option value="all">الكل</option>` + db.branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    const reportBranch = document.getElementById('reportBranch');
    if (reportBranch) {
        reportBranch.innerHTML = `<option value="all">الكل</option>` + db.branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    }
    const reportShift = document.getElementById('reportShift');
    if (reportShift) {
        reportShift.innerHTML = `<option value="all">الكل</option>` + db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }
    renderReportPeriodFilter();
    const isManager = currentUser.role !== 'admin';

    if (!isManager) {
        document.getElementById('dailyFilterBranch').value = 'all';
        document.getElementById('dailyFilterEmp').value = 'all';
        const statusSelect = document.getElementById('dailyFilterStatus');
        if (statusSelect) statusSelect.value = 'all';
    }

    const loginSelect = document.getElementById('currentUserSelect');
    loginSelect.innerHTML = '';
    const displaySpan = document.getElementById('currentUserDisplay');
    const logoutBtn = document.getElementById('logoutBtn');
    if (currentUser) {
        loginSelect.innerHTML = `<option value="${currentUser.id}" selected>${currentUser.name} (${currentUser.role})</option>`;
        loginSelect.disabled = true;
        if (displaySpan) { displaySpan.innerText = `${currentUser.name} (${currentUser.role})`; displaySpan.style.display = 'inline-block'; }
        if (logoutBtn) logoutBtn.style.display = 'inline-block';
    } else {
        db.users.forEach(u => {
            loginSelect.innerHTML += `<option value="${u.id}">${u.name} (${u.role})</option>`;
        });
        loginSelect.disabled = false;
        if (displaySpan) displaySpan.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }

    if (!isManager) {
        const fb = document.getElementById('filterBranch');
        if (fb) fb.value = 'all';
    }

    document.querySelectorAll('.nav-btn').forEach(el => {
        const target = el.dataset.target;
        let tabKey = '';
        switch (target) {
            case 'tab-main': tabKey = 'main'; break;
            case 'tab-daily': tabKey = 'daily'; break;
            case 'tab-archive': tabKey = 'archive'; break;
            case 'tab-employees': tabKey = 'employees'; break;
            case 'tab-branches': tabKey = 'branches'; break;
            case 'tab-users': tabKey = 'users'; break;
            case 'tab-settings': tabKey = 'settings'; break;
        }
        el.style.display = canViewTab(tabKey) ? 'inline-block' : 'none';
    });

    const activeTab = document.querySelector('.tab-content.active')?.id || 'tab-main';
    const targetKey = activeTab.replace('tab-', '');
    if (!canViewTab(targetKey)) {
        const firstVisible = Array.from(document.querySelectorAll('.nav-btn')).find(el => el.style.display !== 'none');
        if (firstVisible) switchTab(firstVisible.dataset.target);
    }

    if (isManager) {
        document.getElementById('filterBranch').value = currentUser.branchId;
        document.getElementById('filterBranch').disabled = true;
        document.getElementById('dailyBranch').value = currentUser.branchId;
        document.getElementById('dailyBranch').disabled = true;
        document.getElementById('dailyFilterBranch').value = currentUser.branchId;
        document.getElementById('dailyFilterBranch').disabled = true;
        document.getElementById('archiveFilterBranch').value = currentUser.branchId;
        document.getElementById('archiveFilterBranch').disabled = true;
    } else {
        document.getElementById('filterBranch').disabled = false;
        document.getElementById('dailyBranch').disabled = false;
        document.getElementById('dailyFilterBranch').disabled = false;
        document.getElementById('archiveFilterBranch').disabled = false;
    }

    const canModifyUsers = canPerform('users', 'add') || canPerform('users', 'edit');
    const canModifyEmployees = canPerform('employees', 'add') || canPerform('employees', 'edit');
    const canModifyBranches = canPerform('branches', 'add') || canPerform('branches', 'edit');
    const canModifySettings = canPerform('settings', 'add') || canPerform('settings', 'edit');
    const canModifyDaily = canPerform('daily', 'add') || canPerform('daily', 'edit');
    const canModifyArchive = canPerform('archive', 'add') || canPerform('archive', 'edit');

    const userControls = [
        'userName', 'userPassword', 'userRole', 'userBranch',
        'tabMainView', 'tabDailyView', 'tabArchiveView', 'tabEmployeesView', 'tabBranchesView', 'tabUsersView', 'tabSettingsView',
        'permMain', 'permDaily', 'permArchive', 'permEmployees', 'permBranches', 'permUsers', 'permSettings', 'btnSaveUser'
    ];
    userControls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canModifyUsers;
    });

    const empControls = ['empNumber', 'empName', 'empDate', 'empBranch', 'empShift', 'empWage', 'empLeave', 'btnSaveEmp'];
    empControls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canModifyEmployees;
    });

    const branchControls = ['branchName', 'btnSaveBranch'];
    branchControls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canModifyBranches;
    });

    const settingsControls = ['settingsCompanyName', 'settingsLogo', 'settingsOperationalDayStart', 'btnSaveSettings', 'holidayName', 'holidayDate', 'btnSaveHoliday', 'shiftName', 'btnSaveShift', 'btnResetShift', 'periodName', 'periodStart', 'periodEnd', 'btnSavePeriod'];
    settingsControls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canModifySettings;
    });

    const dailyControls = ['dailyBranch', 'dailyEmp', 'dailyDate', 'dailyStatus', 'dailyValue', 'dailyNotes', 'btnSaveDaily', 'extraEmp', 'extraDate', 'extraAmount', 'extraNotes', 'btnSaveExtra'];
    dailyControls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canModifyDaily;
    });

    const transferButton = document.querySelector('#tab-daily .btn-warning[onclick="transferDailyRecords()"]');
    if (transferButton) transferButton.disabled = !canModifyArchive;

    renderMainTable();
    renderEmployees();
    renderBranches();
    renderUsers();
    renderDailyFollowups();
    renderDailyExtras();
    renderArchiveReports();
    renderHolidays();
    renderWorkShifts();
    renderShiftPeriods();
    renderReportTable();
    enableTableSorting();
    
    // Enable search on all selects after rendering
    setTimeout(enableSearchableSelects, 100);
}

function renderReportPeriodFilter() {
    const reportShift = document.getElementById('reportShift');
    const reportPeriod = document.getElementById('reportPeriod');
    if (!reportPeriod) return;

    const shiftId = reportShift?.value || 'all';
    let periods = [];

    if (shiftId && shiftId !== 'all') {
        const shift = db.workShifts.find(s => s.id === shiftId);
        periods = shift ? shift.periods : [];
    } else {
        const periodMap = {};
        db.workShifts.forEach(shift => {
            (shift.periods || []).forEach(period => {
                periodMap[period.id] = period;
            });
        });
        periods = Object.values(periodMap);
    }

    reportPeriod.innerHTML = '<option value="all">الكل</option>' + periods.map(period => `<option value="${period.id}">${period.name}</option>`).join('');
}

function refreshShiftDropdowns() {
    const empShiftSelect = document.getElementById('empShift');
    if (empShiftSelect) {
        const shiftOptions = db.workShifts.length
            ? db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('')
            : '<option value="" disabled>لا يوجد دوامات</option>';
        const placeholder = '<option value="" disabled selected>اختر الدوام</option>';
        empShiftSelect.innerHTML = placeholder + shiftOptions;
        empShiftSelect.disabled = db.workShifts.length === 0;
    }

    const reportShift = document.getElementById('reportShift');
    if (reportShift) {
        const savedVal = reportShift.value;
        reportShift.innerHTML = `<option value="all">الكل</option>` + db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        reportShift.value = savedVal && db.workShifts.find(s => s.id === savedVal) ? savedVal : 'all';
        reportShift.onchange = function () { renderReportPeriodFilter(); renderReportTable(); };
    }
    const reportPeriod = document.getElementById('reportPeriod');
    if (reportPeriod) reportPeriod.onchange = renderReportTable;
    renderReportPeriodFilter();

    const selectedShiftSelect = document.getElementById('selectedShiftSelect');
    if (selectedShiftSelect) {
        const savedVal = selectedShiftSelect.value;
        selectedShiftSelect.innerHTML = `<option value="">اختر دواماً</option>` + db.workShifts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        selectedShiftSelect.value = savedVal && db.workShifts.find(s => s.id === savedVal) ? savedVal : '';
        selectedShiftSelect.onchange = function () {
            if (this.value) selectShift(this.value);
            else {
                const idEl = document.getElementById('selectedShiftId');
                if (idEl) idEl.value = '';
                document.getElementById('selectedShiftName').innerText = '';
                document.getElementById('shiftPeriodsSection').style.display = 'none';
                renderWorkShifts();
                renderShiftPeriods();
            }
        };
    }
}

function editShift(id) {
    if (!canPerform('settings', 'edit')) return alert('ليس لديك صلاحية لتعديل الدوام');
    const shift = db.workShifts.find(s => s.id === id);
    if (!shift) return;
    document.getElementById('shiftEditId').value = id;
    document.getElementById('shiftName').value = shift.name;
    showSettingsSubtab('shifts');
}

function renderMainTable() {
    const tbody = document.getElementById('mainTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const branchId = document.getElementById('filterBranch').value;
    const nameFilter = normalizeText(document.getElementById('filterName').value);
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;

    // ترويسة أعمدة التاريخ بالتنسيق العربي الأصلي
    const dynHeaders = document.querySelectorAll('#tab-main .table-wrapper thead .dyn-date');
    const dateRange = getWorkingDatesBetween(from, to, 31);
    const workingDates = dateRange.length > 0 ? dateRange : [new Date().toISOString().split('T')[0]];
    dynHeaders.forEach((th, idx) => {
        if (idx < workingDates.length) {
            const d = new Date(workingDates[idx]);
            th.innerText = d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
            th.dataset.date = workingDates[idx];
            th.style.display = '';
        } else {
            th.innerText = '';
            th.dataset.date = '';
            th.style.display = 'none';
        }
    });

    const filtered = db.employees.filter(emp => {
        return (branchId === 'all' || emp.branchId === branchId)
            && (!nameFilter || normalizeText(emp.name).includes(nameFilter));
    });

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="16">لا توجد بيانات للعرض مع الفلاتر الحالية</td></tr>';
        return;
    }

    const dateRangeEl = document.getElementById('printDateRange');
    if (dateRangeEl) {
        const fromLabel = from || 'البداية';
        const toLabel = to || 'النهاية';
        dateRangeEl.innerText = `من ${fromLabel} إلى ${toLabel}`;
    }

    const canRegister = canPerform('main', 'add') || canPerform('main', 'edit');

    // المجاميع
    let totalExpectedAll = 0;
    let totalAbsenceAll = 0;
    let totalActualAll = 0;
    let totalNetAll = 0;
    const dateAbsenceCounts = workingDates.map(() => 0);
    const dateTotals = workingDates.map(() => 0);

    // الإجازات في النطاق
    const holidaysInRange = db.holidays.filter(h => h.date >= from && h.date <= to).map(h => h.date);

    filtered.forEach(emp => {
        const branchName = db.branches.find(b => b.id === emp.branchId)?.name || '';
        const expectedDays = workingDates.length;
        const dayWage = parseFloat(emp.wage) || 0;

        // حساب الغياب بالطريقة الأصلية
        const empAbsences = db.absences.filter(a => a.empId === emp.id && a.date >= from && a.date <= to && (a.type === 'absent' || a.type === 'annual'));
        const totalAbsenceDays = empAbsences.reduce((sum, a) => sum + a.value, 0);

        // أيام المناسبات
        let holidaysPresent = 0;
        holidaysInRange.forEach(hd => {
            const rec = db.absences.find(a => a.empId === emp.id && a.date === hd);
            if (!rec || (rec && rec.type !== 'absent' && rec.type !== 'annual')) holidaysPresent++;
        });

        const actualDays = Math.max(0, expectedDays - totalAbsenceDays + holidaysPresent);
        const extras = (db.dailyExtras || []).filter(x => x.empId === emp.id && x.date >= from && x.date <= to);
        const totalExtra = extras.reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0);
        const salary = actualDays * dayWage + totalExtra;

        totalExpectedAll += expectedDays;
        totalAbsenceAll += totalAbsenceDays;
        totalActualAll += actualDays;
        totalNetAll += salary;

        // بناء خلايا التاريخ بالشكل الأصلي (0ح, 1غ, 1س, 0م)
        let dateColsHtml = '';
        workingDates.forEach((d, idx) => {
            if (!d) { dateColsHtml += '<td></td>'; return; }
            const statusArr = getDailyStatusArray(emp, d);
            const N = statusArr.length || 1;
            let absentCount = 0, annualCount = 0, holidayCount = 0;
            statusArr.forEach(s => { if (s === 'absent') absentCount++; if (s === 'annual') annualCount++; if (s === 'holiday_present') holidayCount++; });
            const totalAbsenceVal = (absentCount + annualCount) / N;

            if (holidayCount === N) {
                dateColsHtml += `<td class="state-holiday">0م</td>`;
            } else if (annualCount > 0 && annualCount === N) {
                dateColsHtml += `<td class="state-annual">${annualCount === N ? '1س' : (annualCount / N) + 'س'}</td>`;
                dateAbsenceCounts[idx] += annualCount;
                dateTotals[idx] += annualCount / N;
            } else if (totalAbsenceVal > 0) {
                const display = Number.isInteger(totalAbsenceVal) ? `${totalAbsenceVal}غ` : `${totalAbsenceVal.toFixed(1)}غ`;
                dateColsHtml += `<td class="state-absent">${display}</td>`;
                dateAbsenceCounts[idx] += absentCount + annualCount;
                dateTotals[idx] += totalAbsenceVal;
            } else {
                dateColsHtml += `<td class="state-present">0ح</td>`;
            }
        });

        tbody.innerHTML += `
            <tr>
                <td>${emp.employeeNumber || ''}</td>
                <td>${emp.name}</td>
                <td>${branchName}</td>
                <td dir="ltr" style="color:${emp.leaveBalance < 5 ? 'red' : 'green'}">${emp.leaveBalance}</td>
                <td>${expectedDays}</td>
                ${dateColsHtml}
                <td style="color:red; font-weight:bold;">${totalAbsenceDays}</td>
                <td style="color:green; font-weight:bold;">${actualDays}</td>
                <td>${dayWage.toLocaleString()}</td>
                <td style="font-weight:bold;">${totalExtra.toLocaleString()}</td>
                <td style="font-weight:bold; background:#e8f8f5;">${salary.toLocaleString()}</td>
                <td class="no-print">
                    ${canRegister ? `<button onclick="registerStatus('${emp.id}')" style="padding:4px 8px; font-size:12px;">تسجيل الحالة</button>` : ''}
                </td>
            </tr>`;
    });

    // صف المجموع
    let dynTotalsCells = '';
    workingDates.forEach((d, idx) => {
        const totalVal = dateTotals[idx] || 0;
        const display = totalVal ? (Number.isInteger(totalVal) ? totalVal : totalVal.toFixed(1)) + 'غ' : '';
        dynTotalsCells += `<td style="font-weight:bold;">${display}</td>`;
    });

    tbody.innerHTML += `
        <tr style="font-weight:bold; background:#f0f0f0;">
            <td colspan="4">المجموع</td>
            <td>${totalExpectedAll}</td>
            ${dynTotalsCells}
            <td style="color:red;">${totalAbsenceAll}</td>
            <td style="color:green;">${totalActualAll}</td>
            <td></td>
            <td>${db.dailyExtras.filter(x => x.date >= from && x.date <= to && filtered.some(emp => emp.id === x.empId)).reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0).toLocaleString()}</td>
            <td style="background:#e8f8f5;">${totalNetAll.toLocaleString()}</td>
            <td class="no-print"></td>
        </tr>`;
}

function getDayName(dateStr, short = false) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const shortDays = ['أحد', 'إثن', 'ثلاث', 'أربع', 'خميس', 'جمعة', 'سبت'];
    return short ? shortDays[d.getDay()] : days[d.getDay()];
}

function renderReportTable() {
    const tbody = document.getElementById('reportTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const branchId = document.getElementById('reportBranch').value;
    const shiftId = document.getElementById('reportShift').value;
    const periodId = document.getElementById('reportPeriod').value;
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;

    const filtered = db.employees.filter(emp => {
        return (branchId === 'all' || emp.branchId === branchId)
            && (shiftId === 'all' || emp.shiftId === shiftId);
    });

    const workingDates = getWorkingDatesBetween(from, to);
    const dateRangeEl = document.getElementById('printDateRange');
    if (dateRangeEl) {
        dateRangeEl.innerText = `تقرير شامل من ${from || 'البداية'} إلى ${to || 'النهاية'}`;
    }

    filtered.forEach(emp => {
        const branchName = db.branches.find(b => b.id === emp.branchId)?.name || '';
        const shiftName = db.workShifts.find(s => s.id === emp.shiftId)?.name || '';
        const totals = getAbsenceTotalsForEmployee(emp, from, to);
        const absenceDays = totals.absenceDays;
        const annualUsed = totals.annualDays;
        const holidayPresent = totals.holidayPresent;
        const expectedDays = workingDates.length;
        const actualDays = Math.max(0, expectedDays - absenceDays);
        const extras = (db.dailyExtras || []).filter(x => x.empId === emp.id && x.date >= from && x.date <= to);
        const totalExtra = extras.reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0);
        const dayWage = parseFloat(emp.wage) || 0;
        const salary = actualDays * dayWage + totalExtra;

        let periodText = '-';
        if (periodId && periodId !== 'all') {
            const shiftObj = db.workShifts.find(s => s.id === emp.shiftId);
            if (shiftObj) {
                const p = shiftObj.periods.find(pp => pp.id === periodId);
                periodText = p ? p.name : '-';
            }
        } else {
            periodText = shiftName ? `${shiftName}` : '-';
        }

        tbody.innerHTML += `
            <tr>
                <td>${emp.employeeNumber || ''}</td>
                <td>${emp.name}</td>
                <td>${branchName}</td>
                <td>${shiftName || '-'}</td>
                <td>${periodText}</td>
                <td>${actualDays}</td>
                <td>${absenceDays}</td>
                <td>${annualUsed}</td>
                <td>${holidayPresent}</td>
                <td>${totalExtra.toLocaleString()}</td>
                <td>${salary.toLocaleString()}</td>
            </tr>`;
    });
}

function resetMainFilters() {
    const now = new Date();
    const lastWeek = new Date(now);
    lastWeek.setDate(now.getDate() - 6);
    document.getElementById('filterFrom').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('filterTo').value = now.toISOString().split('T')[0];
    document.getElementById('filterName').value = '';
    if (!currentUser || currentUser.role === 'admin') {
        document.getElementById('filterBranch').value = 'all';
    }
    renderMainTable();
}

// ========== CRUD EMPLOYEES ==========
function saveEmployee() {
    const id = document.getElementById('empEditId').value;
    if (id && !canPerform('employees', 'edit')) return alert('ليس لديك صلاحية لتعديل الموظفين');
    if (!id && !canPerform('employees', 'add')) return alert('ليس لديك صلاحية لإضافة الموظفين');
    const employeeNumber = (document.getElementById('empNumber').value || '').trim() || getNextEmployeeNumber();
    const duplicateNumber = db.employees.find(e => e.employeeNumber === employeeNumber && e.id !== id);
    if (duplicateNumber) return alert('رقم الموظف مستخدم مسبقاً');
    const employeeName = document.getElementById('empName').value.trim();
    const duplicateName = db.employees.find(e => normalizeText(e.name) === normalizeText(employeeName) && e.id !== id);
    if (duplicateName) return alert(`اسم الموظف "${employeeName}" موجود مسبقاً`);
    const data = {
        id: id || 'e' + Date.now(),
        employeeNumber,
        name: employeeName,
        date: document.getElementById('empDate').value,
        branchId: document.getElementById('empBranch').value,
        shiftId: document.getElementById('empShift').value,
        wage: parseFloat(document.getElementById('empWage').value),
        leaveBalance: parseFloat(document.getElementById('empLeave').value)
    };
    if (!data.name || !data.wage) return alert('أكمل البيانات');
    if (id) {
        const idx = db.employees.findIndex(e => e.id === id);
        db.employees[idx] = data;
    } else {
        db.employees.push(data);
    }
    resetEmpForm();
    saveDB();
}

function editEmployee(id) {
    if (!canPerform('employees', 'edit')) return alert('ليس لديك صلاحية لتعديل الموظفين');
    const emp = db.employees.find(e => e.id === id);
    document.getElementById('empEditId').value = emp.id;
    document.getElementById('empNumber').value = emp.employeeNumber || '';
    document.getElementById('empName').value = emp.name;
    document.getElementById('empDate').value = emp.date;
    document.getElementById('empBranch').value = emp.branchId;
    document.getElementById('empShift').value = emp.shiftId || '';
    document.getElementById('empWage').value = emp.wage;
    document.getElementById('empLeave').value = emp.leaveBalance;
    document.getElementById('btnSaveEmp').innerText = 'تحديث بيانات الموظف';
    switchTab('tab-employees');
}

function delEmployee(id) {
    if (!canPerform('employees', 'delete')) return alert('ليس لديك صلاحية لحذف الموظفين');
    if (confirm('تأكيد الحذف؟')) { db.employees = db.employees.filter(e => e.id !== id); saveDB(); }
}

function resetEmpForm() {
    document.getElementById('empEditId').value = '';
    document.getElementById('empNumber').value = '';
    document.getElementById('empName').value = '';
    document.getElementById('empShift').value = '';
    document.getElementById('empWage').value = '';
    document.getElementById('empLeave').value = '30';
    document.getElementById('btnSaveEmp').innerText = 'حفظ الموظف';
}

function renderEmployees() {
    const branchFilter = document.getElementById('empFilterBranch')?.value || 'all';
    const filteredEmployees = db.employees.filter(e => branchFilter === 'all' || e.branchId === branchFilter);
    const canEdit = canPerform('employees', 'edit');
    const canDelete = canPerform('employees', 'delete');
    document.getElementById('empTableBody').innerHTML = filteredEmployees.map(e => `
        <tr>
            <td>${e.employeeNumber || ''}</td>
            <td>${e.name}</td>
            <td>${e.date}</td>
            <td>${db.branches.find(b => b.id === e.branchId)?.name || ''}</td>
            <td>${e.wage}</td>
            <td>${e.leaveBalance}</td>
            <td>${db.workShifts.find(s => s.id === e.shiftId)?.name || ''}</td>
            <td>
                ${canEdit ? `<button onclick="editEmployee('${e.id}')" class="btn-warning">تعديل</button>` : ''}
                ${canDelete ? `<button onclick="delEmployee('${e.id}')" class="btn-danger">حذف</button>` : ''}
            </td>
        </tr>
    `).join('');
}

function getNextEmployeeNumber() {
    const numbers = db.employees
        .map(e => parseInt(e.employeeNumber, 10))
        .filter(n => Number.isFinite(n));
    return String((numbers.length ? Math.max(...numbers) : 0) + 1);
}

// ========== CRUD BRANCHES ==========
function saveBranch() {
    const id = document.getElementById('branchEditId').value;
    if (id && !canPerform('branches', 'edit')) return alert('ليس لديك صلاحية لتعديل الفروع');
    if (!id && !canPerform('branches', 'add')) return alert('ليس لديك صلاحية لإضافة الفروع');
    const branchNumber = (document.getElementById('branchNumber').value || '').trim() || getNextBranchNumber();
    const name = document.getElementById('branchName').value.trim();
    const address = document.getElementById('branchAddress').value.trim();
    if (!name) return;
    const duplicateBranch = db.branches.find(b => normalizeText(b.name) === normalizeText(name) && b.id !== id);
    if (duplicateBranch) return alert(`الفرع "${name}" موجود مسبقاً`);
    const duplicateNumber = db.branches.find(b => b.branchNumber === branchNumber && b.id !== id);
    if (duplicateNumber) return alert(`رقم الفرع "${branchNumber}" مستخدم مسبقاً`);
    if (id) {
        const branch = db.branches.find(b => b.id === id);
        branch.name = name;
        branch.branchNumber = branchNumber;
        branch.address = address;
    } else {
        db.branches.push({ id: 'b' + Date.now(), branchNumber, name, address });
    }
    document.getElementById('branchEditId').value = '';
    document.getElementById('branchNumber').value = '';
    document.getElementById('branchName').value = '';
    document.getElementById('branchAddress').value = '';
    saveDB();
}

function editBranch(id) {
    if (!canPerform('branches', 'edit')) return alert('ليس لديك صلاحية لتعديل الفروع');
    const b = db.branches.find(x => x.id === id);
    document.getElementById('branchEditId').value = b.id;
    document.getElementById('branchNumber').value = b.branchNumber || '';
    document.getElementById('branchName').value = b.name;
    document.getElementById('branchAddress').value = b.address || '';
}

function delBranch(id) {
    if (!canPerform('branches', 'delete')) return alert('ليس لديك صلاحية لحذف الفروع');
    if (confirm('تأكيد الحذف؟')) { db.branches = db.branches.filter(x => x.id !== id); saveDB(); }
}

function renderBranches() {
    const canEdit = canPerform('branches', 'edit');
    const canDelete = canPerform('branches', 'delete');
    document.getElementById('branchesTableBody').innerHTML = db.branches.map(b => `
        <tr><td>${b.branchNumber || b.id}</td><td>${b.name}</td><td>${b.address || ''}</td>
        <td>${canEdit ? `<button onclick="editBranch('${b.id}')" class="btn-warning">تعديل</button>` : ''} ${canDelete ? `<button onclick="delBranch('${b.id}')" class="btn-danger">حذف</button>` : ''}</td></tr>
    `).join('');
}

function getNextBranchNumber() {
    const numbers = db.branches
        .map(b => parseInt(b.branchNumber, 10))
        .filter(n => Number.isFinite(n));
    return String((numbers.length ? Math.max(...numbers) : 0) + 1);
}

// ========== CRUD USERS ==========
function saveUser() {
    const id = document.getElementById('userEditId').value;
    if (id && !canPerform('users', 'edit')) return alert('ليس لديك صلاحية لتعديل المستخدمين');
    if (!id && !canPerform('users', 'add')) return alert('ليس لديك صلاحية لإضافة المستخدمين');
    const passwordInput = document.getElementById('userPassword').value;
    const data = {
        id: id || 'u' + Date.now(),
        name: document.getElementById('userName').value,
        role: document.getElementById('userRole').value,
        branchId: document.getElementById('userBranch').value,
        allowedTabs: {
            main: document.getElementById('tabMainView').checked,
            daily: document.getElementById('tabDailyView').checked,
            archive: document.getElementById('tabArchiveView').checked,
            employees: document.getElementById('tabEmployeesView').checked,
            branches: document.getElementById('tabBranchesView').checked,
            users: document.getElementById('tabUsersView').checked,
            settings: document.getElementById('tabSettingsView').checked
        },
        tabPermissions: {
            main: document.getElementById('permMain').value,
            daily: document.getElementById('permDaily').value,
            archive: document.getElementById('permArchive').value,
            employees: document.getElementById('permEmployees').value,
            branches: document.getElementById('permBranches').value,
            users: document.getElementById('permUsers').value,
            settings: document.getElementById('permSettings').value
        }
    };
    if (!data.name) return alert('أكمل البيانات');
    const duplicateUser = db.users.find(u => normalizeText(u.name) === normalizeText(data.name) && u.id !== id);
    if (duplicateUser) return alert(`اسم المستخدم "${data.name}" موجود مسبقاً`);
    if (id) {
        const idx = db.users.findIndex(u => u.id === id);
        if (idx !== -1) {
            const existing = db.users[idx];
            data.password = passwordInput ? passwordInput : existing.password;
            db.users[idx] = data;
        }
    } else {
        if (!passwordInput) return alert('يرجى إدخال كلمة مرور للمستخدم الجديد');
        data.password = passwordInput;
        db.users.push(data);
    }
    document.getElementById('userEditId').value = '';
    document.getElementById('userName').value = '';
    document.getElementById('userPassword').value = '';
    saveDB();
    renderAll();
}

function editUser(id) {
    if (!canPerform('users', 'edit')) return alert('ليس لديك صلاحية لتعديل المستخدمين');
    const u = db.users.find(x => x.id === id);
    if (!u) return;
    document.getElementById('userEditId').value = u.id;
    document.getElementById('userName').value = u.name;
    document.getElementById('userPassword').value = '';
    document.getElementById('userRole').value = u.role;
    document.getElementById('userBranch').value = u.branchId;
    document.getElementById('tabMainView').checked = !!getUserAllowedTabs(u).main;
    document.getElementById('tabDailyView').checked = !!getUserAllowedTabs(u).daily;
    document.getElementById('tabArchiveView').checked = !!getUserAllowedTabs(u).archive;
    document.getElementById('tabEmployeesView').checked = !!getUserAllowedTabs(u).employees;
    document.getElementById('tabBranchesView').checked = !!getUserAllowedTabs(u).branches;
    document.getElementById('tabUsersView').checked = !!getUserAllowedTabs(u).users;
    document.getElementById('tabSettingsView').checked = !!getUserAllowedTabs(u).settings;
    document.getElementById('permMain').value = getUserPermissionLevel(u, 'main');
    document.getElementById('permDaily').value = getUserPermissionLevel(u, 'daily');
    document.getElementById('permArchive').value = getUserPermissionLevel(u, 'archive');
    document.getElementById('permEmployees').value = getUserPermissionLevel(u, 'employees');
    document.getElementById('permBranches').value = getUserPermissionLevel(u, 'branches');
    document.getElementById('permUsers').value = getUserPermissionLevel(u, 'users');
    document.getElementById('permSettings').value = getUserPermissionLevel(u, 'settings');
}

function delUser(id) {
    if (!canPerform('users', 'delete')) return alert('ليس لديك صلاحية لحذف المستخدمين');
    if (id === currentUser.id) return alert("لا يمكنك حذف حسابك الحالي!");
    if (confirm('تأكيد الحذف؟')) { db.users = db.users.filter(x => x.id !== id); saveDB(); }
}

function renderUsers() {
    const canEdit = canPerform('users', 'edit');
    const canDelete = canPerform('users', 'delete');
    document.getElementById('usersTableBody').innerHTML = db.users.map(u => `
        <tr><td>${u.name}</td><td>${u.role === 'admin' ? 'مدير نظام' : 'مستخدم فرع'}</td><td>${db.branches.find(b => b.id === u.branchId)?.name || 'الكل'}</td><td>${formatUserTabs(u)}</td><td>${formatUserPermissions(u)}</td>
        <td>${canEdit ? `<button onclick="editUser('${u.id}')" class="btn-warning">تعديل</button>` : ''} ${canDelete ? `<button onclick="delUser('${u.id}')" class="btn-danger">حذف</button>` : ''}</td></tr>
    `).join('');
}

// ========== Settings - Holidays ==========
function showSettingsSubtab(name) {
    const generalTab = document.getElementById('settings-subtab-general');
    const holidaysTab = document.getElementById('settings-subtab-holidays');
    const shiftsTab = document.getElementById('settings-subtab-shifts');
    if (generalTab) generalTab.style.display = name === 'general' ? 'block' : 'none';
    if (holidaysTab) holidaysTab.style.display = name === 'holidays' ? 'block' : 'none';
    if (shiftsTab) shiftsTab.style.display = name === 'shifts' ? 'block' : 'none';
    const generalBtn = document.getElementById('settings-tab-general-btn');
    const holidaysBtn = document.getElementById('settings-tab-holidays-btn');
    const shiftsBtn = document.getElementById('settings-tab-shifts-btn');
    if (generalBtn) generalBtn.classList.toggle('active', name === 'general');
    if (holidaysBtn) holidaysBtn.classList.toggle('active', name === 'holidays');
    if (shiftsBtn) shiftsBtn.classList.toggle('active', name === 'shifts');
    if (name === 'shifts') {
        renderWorkShifts();
        renderShiftPeriods();
    }
}

function saveHoliday() {
    const id = document.getElementById('holidayEditId').value;
    if (id && !canPerform('settings', 'edit')) return alert('ليس لديك صلاحية لتعديل المناسبات');
    if (!id && !canPerform('settings', 'add')) return alert('ليس لديك صلاحية لإضافة المناسبات');
    const name = document.getElementById('holidayName').value.trim();
    const date = document.getElementById('holidayDate').value;
    if (!name || !date) return alert('أكمل اسم المناسبة والتاريخ');
    const duplicateHoliday = db.holidays.find(h => (normalizeText(h.name) === normalizeText(name) || h.date === date) && h.id !== id);
    if (duplicateHoliday) return alert(`المناسبة أو التاريخ موجود مسبقاً`);
    if (id) {
        const h = db.holidays.find(x => x.id === id);
        h.name = name; h.date = date;
    } else {
        db.holidays.push({ id: 'h' + Date.now(), name, date });
    }
    resetHolidayForm();
    saveDB();
}

function resetHolidayForm() {
    document.getElementById('holidayEditId').value = '';
    document.getElementById('holidayName').value = '';
    document.getElementById('holidayDate').value = '';
}

function renderHolidays() {
    const canEdit = canPerform('settings', 'edit');
    const canDelete = canPerform('settings', 'delete');
    const tbody = document.getElementById('holidaysTableBody');
    tbody.innerHTML = db.holidays.map(h => `
        <tr><td>${h.name}</td><td>${h.date}</td>
        <td>${canEdit ? `<button onclick="editHoliday('${h.id}')" class="btn-warning">تعديل</button>` : ''} ${canDelete ? `<button onclick="deleteHoliday('${h.id}')" class="btn-danger">حذف</button>` : ''}</td></tr>
    `).join('');
}

function editHoliday(id) {
    if (!canPerform('settings', 'edit')) return alert('ليس لديك صلاحية لتعديل المناسبات');
    const h = db.holidays.find(x => x.id === id);
    if (!h) return;
    document.getElementById('holidayEditId').value = h.id;
    document.getElementById('holidayName').value = h.name;
    document.getElementById('holidayDate').value = h.date;
    showSettingsSubtab('holidays');
}

function deleteHoliday(id) {
    if (!canPerform('settings', 'delete')) return alert('ليس لديك صلاحية لحذف المناسبات');
    if (!confirm('تأكيد حذف المناسبة/العيد؟')) return;
    db.holidays = db.holidays.filter(x => x.id !== id);
    saveDB();
}

// ========== Settings - Work Shifts ==========
function saveShift() {
    if (!canPerform('settings', 'edit') && !canPerform('settings', 'add')) return alert('ليس لديك صلاحية لحفظ الدوام');
    const id = document.getElementById('shiftEditId').value;
    const name = document.getElementById('shiftName').value.trim();
    if (!name) return alert('أكمل اسم الدوام');
    let savedShiftId = id;
    if (id) {
        const shift = db.workShifts.find(s => s.id === id);
        if (shift) shift.name = name;
    } else {
        savedShiftId = 's' + Date.now();
        db.workShifts.push({ id: savedShiftId, name, periods: [] });
    }
    resetShiftForm();
    saveDB();
    selectShift(savedShiftId);
    refreshShiftDropdowns();
}

function resetShiftForm() {
    document.getElementById('shiftEditId').value = '';
    document.getElementById('shiftName').value = '';
}

function selectShift(id) {
    const shift = db.workShifts.find(s => s.id === id);
    if (!shift) return;
    document.getElementById('selectedShiftId').value = id;
    document.getElementById('selectedShiftName').innerText = shift.name;
    document.getElementById('shiftPeriodsSection').style.display = 'block';
    renderWorkShifts();
    renderShiftPeriods();
}

function deleteShift(id) {
    if (!canPerform('settings', 'delete')) return alert('ليس لديك صلاحية لحذف الدوام');
    if (!confirm('تأكيد حذف الدوام؟')) return;
    db.workShifts = db.workShifts.filter(s => s.id !== id);
    if (document.getElementById('selectedShiftId').value === id) {
        document.getElementById('selectedShiftId').value = '';
        document.getElementById('selectedShiftName').innerText = '';
        document.getElementById('shiftPeriodsSection').style.display = 'none';
        resetPeriodForm();
    }
    saveDB();
    renderWorkShifts();
}

function renderWorkShifts() {
    const selectedShiftId = document.getElementById('selectedShiftId').value;
    const tbody = document.getElementById('workShiftsTableBody');
    tbody.innerHTML = db.workShifts.map(shift => `
        <tr ${selectedShiftId === shift.id ? 'style="background:#eef7ff;"' : ''}>
            <td>${shift.name}</td>
            <td>${shift.periods?.length || 0}</td>
            <td>
                <button onclick="selectShift('${shift.id}')">تحديد</button>
                ${canPerform('settings', 'edit') ? `<button onclick="editShift('${shift.id}')" class="btn-warning">تعديل</button>` : ''}
                ${canPerform('settings', 'delete') ? `<button onclick="deleteShift('${shift.id}')" class="btn-danger">حذف</button>` : ''}
            </td>
        </tr>
    `).join('');
}

function renderShiftPeriods() {
    const shiftId = document.getElementById('selectedShiftId').value;
    const shift = db.workShifts.find(s => s.id === shiftId);
    const section = document.getElementById('shiftPeriodsSection');
    if (!shift) {
        section.style.display = 'none';
        return;
    }
    document.getElementById('selectedShiftName').innerText = shift.name;
    section.style.display = 'block';
    const tbody = document.getElementById('shiftPeriodsTableBody');
    tbody.innerHTML = (shift.periods || []).map(period => `
        <tr>
            <td>${period.name}</td>
            <td>${period.startTime}</td>
            <td>${period.endTime}</td>
            <td>
                ${canPerform('settings', 'edit') ? `<button onclick="editShiftPeriod('${period.id}')" class="btn-warning">تعديل</button>` : ''}
                ${canPerform('settings', 'delete') ? `<button onclick="deleteShiftPeriod('${period.id}')" class="btn-danger">حذف</button>` : ''}
            </td>
        </tr>
    `).join('');
}

function editShiftPeriod(id) {
    if (!canPerform('settings', 'edit')) return alert('ليس لديك صلاحية لتعديل الفترة');
    const shiftId = document.getElementById('selectedShiftId').value;
    const shift = db.workShifts.find(s => s.id === shiftId);
    if (!shift) return;
    const period = shift.periods.find(p => p.id === id);
    if (!period) return;
    document.getElementById('periodEditId').value = id;
    document.getElementById('periodName').value = period.name;
    document.getElementById('periodStart').value = period.startTime;
    document.getElementById('periodEnd').value = period.endTime;
}

function deleteShiftPeriod(id) {
    if (!canPerform('settings', 'delete')) return alert('ليس لديك صلاحية لحذف الفترة');
    const shiftId = document.getElementById('selectedShiftId').value;
    const shift = db.workShifts.find(s => s.id === shiftId);
    if (!shift) return alert('اختر دواماً أولاً');
    if (!confirm('تأكيد حذف الفترة؟')) return;
    shift.periods = shift.periods.filter(p => p.id !== id);
    saveDB();
    renderShiftPeriods();
    renderWorkShifts();
}

function resetPeriodForm() {
    document.getElementById('periodEditId').value = '';
    document.getElementById('periodName').value = '';
    document.getElementById('periodStart').value = '';
    document.getElementById('periodEnd').value = '';
}

function changeUser() {
    const selectedUser = db.users.find(u => u.id === document.getElementById('currentUserSelect').value);
    if (!selectedUser) return;
    if (selectedUser.password) {
        const password = prompt('أدخل كلمة المرور للمستخدم:');
        if (password === null) {
            document.getElementById('currentUserSelect').value = currentUser.id;
            return;
        }
        if (password !== selectedUser.password) {
            alert('كلمة المرور غير صحيحة');
            document.getElementById('currentUserSelect').value = currentUser.id;
            return;
        }
    }
    currentUser = selectedUser;
    renderAll();
}

// ========== Daily Follow-ups ==========
function renderDailyFollowups() {
    const tbody = document.getElementById('dailyTableBody');
    tbody.innerHTML = '';
    const branchId = document.getElementById('dailyFilterBranch').value;
    const empId = document.getElementById('dailyFilterEmp').value;
    const statusFilter = (document.getElementById('dailyFilterStatus') && document.getElementById('dailyFilterStatus').value) || 'all';
    const from = document.getElementById('dailyFilterFrom').value;
    const to = document.getElementById('dailyFilterTo').value;
    const canDelete = canPerform('daily', 'delete');

    const filtered = db.dailyFollowUps.filter(item => {
        return (branchId === 'all' || item.branchId === branchId)
            && (empId === 'all' || item.empId === empId)
            && (statusFilter === 'all' || item.statusType === statusFilter)
            && (!from || item.date >= from)
            && (!to || item.date <= to);
    });

    filtered.forEach(item => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '' };
        const branchName = db.branches.find(b => b.id === item.branchId)?.name || '';
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }

        tbody.innerHTML += `
            <tr>
                <td>${getDayName(item.date)} - ${item.date}</td>
                <td>${employee.employeeNumber || ''}</td>
                <td>${employee.name}</td>
                <td>${branchName}</td>
                <td>${statusLabel}</td>
                <td>${periodLabel}</td>
                <td>${item.notes || '-'}</td>
                <td class="no-print">${canDelete ? `<button onclick="deleteDailyEntry('${item.id}')" class="btn-danger">حذف</button>` : ''}</td>
            </tr>
        `;
    });
}

function saveDailyEntry() {
    if (!canPerform('daily', 'add') && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لحفظ سجلات التعقيب اليومي');
    const id = document.getElementById('dailyEditId').value;
    const empId = document.getElementById('dailyEmp').value;
    const branchId = document.getElementById('dailyBranch').value;
    const date = document.getElementById('dailyDate').value;
    const statusType = document.getElementById('dailyStatus').value;
    const periodEl = document.getElementById('dailyPeriod');
    const period = periodEl ? periodEl.value : 'all';
    const notes = document.getElementById('dailyNotes').value.trim();
    if (!empId || !branchId || !date) return alert('أكمل بيانات التعقيب اليومي');
    if (id && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل سجل التعقيب اليومي');
    if (!id && !canPerform('daily', 'add')) return alert('ليس لديك صلاحية لإضافة سجل التعقيب اليومي');
    const duplicateDaily = db.dailyFollowUps.find(x => x.empId === empId && x.date === date && x.period === period && x.id !== id);
    if (duplicateDaily) return alert('يوجد تعقيب لنفس الموظف، نفس التاريخ ونفس الفترة مسبقاً');
    const entry = { id: id || 'd' + Date.now(), empId, branchId, date, statusType, period, notes, createdAt: new Date().toISOString() };
    const empObj = findEmployeeById(empId);
    if (id) {
        const existing = db.dailyFollowUps.find(x => x.id === id);
        if (existing && existing.statusType === 'annual' && empObj) {
            const restore = (existing.period === 'all') ? 1 : (1 / getPeriodsCountForEmployee(empObj));
            empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) + restore;
        }
    }
    if (entry.statusType === 'annual' && empObj) {
        const deduct = (entry.period === 'all') ? 1 : (1 / getPeriodsCountForEmployee(empObj));
        empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) - deduct;
    }
    if (id) {
        const idx = db.dailyFollowUps.findIndex(x => x.id === id);
        if (idx !== -1) db.dailyFollowUps[idx] = entry;
    } else {
        db.dailyFollowUps.push(entry);
    }
    resetDailyForm();
    saveDB();
}

function resetDailyForm() {
    document.getElementById('dailyEditId').value = '';
    document.getElementById('dailyBranch').value = '';
    document.getElementById('dailyEmp').value = '';
    document.getElementById('dailyDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('dailyStatus').value = 'present';
    const periodEl = document.getElementById('dailyPeriod');
    if (periodEl) periodEl.value = 'all';
    document.getElementById('dailyNotes').value = '';
}

function deleteDailyEntry(id) {
    if (!canPerform('daily', 'delete')) return alert('ليس لديك صلاحية لحذف سجلات التعقيب اليومي');
    if (!confirm('هل تريد حذف هذا السجل؟')) return;
    const entry = db.dailyFollowUps.find(x => x.id === id);
    if (entry && entry.statusType === 'annual') {
        const empObj = findEmployeeById(entry.empId);
        if (empObj) {
            const restore = (entry.period === 'all') ? 1 : (1 / getPeriodsCountForEmployee(empObj));
            empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) + restore;
        }
    }
    db.dailyFollowUps = db.dailyFollowUps.filter(x => x.id !== id);
    saveDB();
}

// ========== Daily Extras ==========
function renderDailyExtras() {
    const tbody = document.getElementById('extraTableBody');
    tbody.innerHTML = '';
    const branchId = document.getElementById('dailyFilterBranch').value;
    const empId = document.getElementById('extraFilterEmp').value;
    const from = document.getElementById('extraFilterFrom').value;
    const to = document.getElementById('extraFilterTo').value;
    const canEdit = canPerform('daily', 'edit');
    const canDelete = canPerform('daily', 'delete');

    const filtered = db.dailyExtras.filter(item => {
        const employee = db.employees.find(e => e.id === item.empId) || { branchId: 'all' };
        return (branchId === 'all' || employee.branchId === branchId)
            && (empId === 'all' || item.empId === empId)
            && (!from || item.date >= from)
            && (!to || item.date <= to);
    });

    filtered.forEach(item => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '', branchId: '' };
        const branchName = db.branches.find(b => b.id === employee.branchId)?.name || '';
        tbody.innerHTML += `
            <tr>
                <td>${getDayName(item.date)} - ${item.date}</td>
                <td>${employee.employeeNumber || ''}</td>
                <td>${employee.name}</td>
                <td>${branchName}</td>
                <td>${(parseFloat(item.amount) || 0).toLocaleString()}</td>
                <td>${item.notes || '-'}</td>
                <td class="no-print">
                    ${canEdit ? `<button onclick="editDailyExtra('${item.id}')" class="btn-warning">تعديل</button>` : ''}
                    ${canDelete ? `<button onclick="deleteDailyExtra('${item.id}')" class="btn-danger">حذف</button>` : ''}
                </td>
            </tr>
        `;
    });
}

function saveDailyExtra() {
    if (!canPerform('daily', 'add') && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لحفظ الإضافي');
    const id = document.getElementById('extraEditId').value;
    const empId = document.getElementById('extraEmp').value;
    const date = document.getElementById('extraDate').value;
    const amount = parseFloat(document.getElementById('extraAmount').value) || 0;
    const notes = document.getElementById('extraNotes').value.trim();
    if (!empId || !date || amount <= 0) return alert('أكمل بيانات الإضافي بمبلغ صحيح');
    if (id && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل الإضافي');
    if (!id && !canPerform('daily', 'add')) return alert('ليس لديك صلاحية لإضافة الإضافي');
    const duplicateExtra = db.dailyExtras.find(x => x.empId === empId && x.date === date && x.id !== id);
    if (duplicateExtra) return alert(`يوجد مبلغ إضافي مسجل مسبقاً للموظف ${getEmployeeLabel(empId)} في تاريخ ${date}`);

    const entry = { id: id || 'x' + Date.now(), empId, date, amount, notes, createdAt: new Date().toISOString() };
    if (id) {
        const idx = db.dailyExtras.findIndex(x => x.id === id);
        if (idx !== -1) db.dailyExtras[idx] = entry;
    } else {
        db.dailyExtras.push(entry);
    }
    resetDailyExtraForm();
    saveDB();
}

function editDailyExtra(id) {
    if (!canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل الإضافي');
    const entry = db.dailyExtras.find(x => x.id === id);
    if (!entry) return alert('سجل الإضافي غير موجود');
    document.getElementById('extraEditId').value = entry.id;
    document.getElementById('extraEmp').value = entry.empId;
    document.getElementById('extraDate').value = entry.date;
    document.getElementById('extraAmount').value = entry.amount;
    document.getElementById('extraNotes').value = entry.notes || '';
    document.getElementById('btnSaveExtra').innerText = 'تحديث الإضافي';
    switchDailyPanel('daily-extra-panel');
}

function resetDailyExtraForm() {
    document.getElementById('extraEditId').value = '';
    document.getElementById('extraEmp').value = '';
    document.getElementById('extraDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('extraAmount').value = '';
    document.getElementById('extraNotes').value = '';
    document.getElementById('btnSaveExtra').innerText = 'إضافة الإضافي';
}

function deleteDailyExtra(id) {
    if (!canPerform('daily', 'delete')) return alert('ليس لديك صلاحية لحذف الإضافي');
    if (!confirm('هل تريد حذف هذا الإضافي؟')) return;
    db.dailyExtras = db.dailyExtras.filter(x => x.id !== id);
    saveDB();
}

function switchDailyPanel(panelId) {
    document.querySelectorAll('.daily-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.sub-tab-btn[data-daily-panel]').forEach(btn => btn.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.sub-tab-btn[data-daily-panel="${panelId}"]`);
    if (btn) btn.classList.add('active');
}

// ========== Transfer / Archive ==========
function transferDailyRecords() {
    if (!canPerform('archive', 'add')) return alert('ليس لديك صلاحية لترحيل ومشاركة التعقيب');
    const branchId = document.getElementById('dailyFilterBranch').value;
    const dateFrom = document.getElementById('dailyFilterFrom').value;
    const dateTo = document.getElementById('dailyFilterTo').value;
    const branchName = branchId === 'all' ? 'الكل' : db.branches.find(b => b.id === branchId)?.name || 'الكل';
    const records = db.dailyFollowUps.filter(item => {
        return (branchId === 'all' || item.branchId === branchId)
            && (!dateFrom || item.date >= dateFrom)
            && (!dateTo || item.date <= dateTo);
    });
    if (!records.length) return alert('لا توجد سجلات لنقلها. اختر فرعاً وفترة صحيحة.');
    const duplicateMainFromTransfer = records.find(item =>
        item.statusType !== 'present' && db.absences.some(a => a.empId === item.empId && a.date === item.date)
    );
    if (duplicateMainFromTransfer) {
        return alert(`لا يمكن ترحيل التعقيب؛ يوجد سجل مسبقاً في التعقيب الرئيسي للموظف ${getEmployeeLabel(duplicateMainFromTransfer.empId)} في تاريخ ${duplicateMainFromTransfer.date}.`);
    }

    const reportId = 'r' + Date.now();
    const fileName = `archive_${branchName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
    db.archivedReports.push({ id: reportId, branchId, branchName, date: new Date().toISOString().split('T')[0], createdAt: new Date().toISOString(), entries: records, fileName });

    records.forEach(item => {
        if (item.statusType === 'present') return;
        const empObj = findEmployeeById(item.empId);
        const periodsCount = getPeriodsCountForEmployee(empObj);
        const value = (item.period === 'all' || !item.period) ? 1 : (1 / periodsCount);
        const rec = { id: 'a' + Date.now() + Math.random().toString(36).slice(2), empId: item.empId, date: item.date, value: value, type: item.statusType };
        addOrReplaceAbsenceRecord(rec);
    });

    const pdfContent = buildArchivePdf(reportId, branchName, records);
    downloadBlob(pdfContent, fileName, 'application/pdf');

    db.dailyFollowUps = db.dailyFollowUps.filter(item => !records.includes(item));
    saveDB();
    alert('تم ترحيل التعقيب وإنشاء ملف PDF للأرشفة.');
}

function buildArchivePdf(reportId, branchName, records) {
    const headerText = `تقرير أرشفة التعقيب المرحل\nالفرع: ${branchName}\nالتاريخ: ${new Date().toLocaleDateString('ar-EG')}\n\n`;
    const lines = records.map(item => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : 'مناسبة';
        return `${getDayName(item.date)} ${item.date} | ${employee.name} | ${statusLabel} | ${item.value} | ${item.notes || '-'} `;
    });
    const contentLines = [
        `BT /F1 24 Tf 50 740 Td (${escapePdfText('تقرير أرشفة التعقيب المرحل')}) Tj ET`,
        `BT /F1 14 Tf 50 710 Td (${escapePdfText(`الفرع: ${branchName}`)}) Tj ET`,
        `BT /F1 14 Tf 50 690 Td (${escapePdfText(`التاريخ: ${new Date().toLocaleDateString('ar-EG')}`)}) Tj ET`,
        ...lines.map((line, idx) => `BT /F1 12 Tf 50 ${670 - idx * 18} Td (${escapePdfText(line)}) Tj ET`)
    ].join('\n');
    const streamText = `${contentLines}\n`;
    const streamLength = getByteLength(streamText);
    const objects = [];

    objects.push({ id: 1, text: '<< /Type /Catalog /Pages 2 0 R >>' });
    objects.push({ id: 2, text: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' });
    objects.push({ id: 3, text: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' });
    objects.push({ id: 4, text: `<< /Length ${streamLength} >>\nstream\n${streamText}endstream` });
    objects.push({ id: 5, text: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });

    let pdf = '%PDF-1.5\n%âãÏÓ\n';
    const xrefs = ['0000000000 65535 f \n'];
    let position = getByteLength(pdf);
    for (const obj of objects) {
        const objHeader = `${obj.id} 0 obj\n`;
        const objFooter = '\nendobj\n';
        xrefs.push(String(position).padStart(10, '0') + ' 00000 n \n');
        pdf += objHeader + obj.text + objFooter;
        position += getByteLength(objHeader + obj.text + objFooter);
    }
    const xrefStart = position;
    pdf += 'xref\n0 ' + (objects.length + 1) + '\n' + xrefs.join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return pdf;
}

function getByteLength(str) {
    return new TextEncoder().encode(str).length;
}

function escapePdfText(text) {
    return text.replace(/([\\()])/g, '\\$1');
}

function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function renderArchiveReports() {
    const tbody = document.getElementById('archiveTableBody');
    tbody.innerHTML = '';
    const branchId = document.getElementById('archiveFilterBranch').value;
    const from = document.getElementById('archiveFilterFrom').value;
    const to = document.getElementById('archiveFilterTo').value;
    const canDownload = canPerform('archive', 'view');

    const filtered = db.archivedReports.filter(report => {
        return (branchId === 'all' || report.branchId === branchId)
            && (!from || report.date >= from)
            && (!to || report.date <= to);
    });

    filtered.forEach(report => {
        tbody.innerHTML += `
            <tr>
                <td>${report.branchName}</td>
                <td>${report.date}</td>
                <td>${report.entries.length}</td>
                <td>${new Date(report.createdAt).toLocaleString('ar-EG')}</td>
                <td class="no-print">${canDownload ? `<button onclick="downloadArchivedReport('${report.id}')">تنزيل PDF</button>` : ''}</td>
            </tr>
        `;
    });
}

function downloadArchivedReport(reportId) {
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');
    const content = buildArchivePdf(report.id, report.branchName, report.entries);
    downloadBlob(content, report.fileName, 'application/pdf');
}

function registerStatus(empId) {
    if (!canPerform('main', 'add') && !canPerform('main', 'edit')) return alert('ليس لديك صلاحية لتسجيل حالة الموظف');
    const emp = db.employees.find(e => e.id === empId);
    const status = prompt(`تسجيل الحالة للموظف: ${emp.name}\nاختر رقم الحالة:\n1 - حاضر\n2 - غائب\n3 - مناسبة\n4 - اجازة سنوية`, '1');
    if (!status) return;

    const d = prompt(`أدخل التاريخ (YYYY-MM-DD):`, new Date().toISOString().split('T')[0]);
    if (!d) return;
    const existingMainRecord = db.absences.find(a => a.empId === empId && a.date === d);
    if (existingMainRecord) return alert(`يوجد سجل في التعقيب الرئيسي مسبقاً للموظف ${getEmployeeLabel(empId)} في تاريخ ${d}`);
    const vStr = prompt("أدخل قيمة الحالة (1 ليوم كامل، 0.5 لنصف يوم):", "1");
    const val = parseFloat(vStr);
    if (val !== 1 && val !== 0.5) return alert("قيمة خاطئة!");

    let newRec = { id: Date.now().toString(), empId: empId, date: d, value: val, type: '' };
    if (status === '1') {
        newRec.type = 'present';
        addOrReplaceAbsenceRecord(newRec);
        saveDB();
        return alert('تم تسجيل الحالة: حاضر');
    }

    if (status === '2') {
        newRec.type = 'absent';
        addOrReplaceAbsenceRecord(newRec);
        saveDB();
        return alert('تم تسجيل الحالة: غائب');
    }

    if (status === '3') {
        newRec.type = 'holiday_present';
        addOrReplaceAbsenceRecord(newRec);
        saveDB();
        return alert('تم تسجيل الحالة: مناسبة');
    }

    if (status === '4') {
        newRec.type = 'annual';
        const empObj = findEmployeeById(empId);
        if (empObj && empObj.leaveBalance < val) return alert('رصيد الاجازة السنوية لا يكفي');
        addOrReplaceAbsenceRecord(newRec);
        saveDB();
        return alert('تم تسجيل الحالة: اجازة سنوية');
    }
}

// ========== Settings & UI ==========
function saveSettings() {
    if (!canPerform('settings', 'edit') && !canPerform('settings', 'add')) return alert('ليس لديك صلاحية لحفظ الإعدادات');
    db.settings.companyName = document.getElementById('settingsCompanyName').value;
    db.settings.logo = document.getElementById('settingsLogo').value;
    db.settings.operationalDayStart = document.getElementById('settingsOperationalDayStart').value || '06:00';
    db.settings.weeklyOffDays = Array.from(document.querySelectorAll('#settingsWeeklyOff input[type=checkbox]:checked')).map(input => input.value);
    if (!db.settings.weeklyOffDays.length) db.settings.weeklyOffDays = ['5'];
    saveDB();
    document.getElementById('weeklyOffSaveMessage').style.display = 'block';
    setTimeout(() => { document.getElementById('weeklyOffSaveMessage').style.display = 'none'; }, 2000);
}

function enhanceSettingsLogoInput() {
    const orig = document.getElementById('settingsLogo');
    if (!orig) return;
    if (document.getElementById('settingsLogoFile')) return;
    orig.style.display = 'none';

    const container = document.createElement('div');
    container.id = 'settingsLogoContainer';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '8px';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.id = 'settingsLogoFile';

    const preview = document.createElement('img');
    preview.id = 'settingsLogoPreview';
    preview.style.maxWidth = '120px';
    preview.style.maxHeight = '40px';
    preview.style.objectFit = 'contain';
    preview.alt = 'معاينة الشعار';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.innerText = 'إزالة';
    removeBtn.onclick = function () {
        orig.value = '';
        db.settings.logo = '';
        preview.src = '';
        fileInput.value = '';
        document.getElementById('printLogo').src = '';
    };

    if (orig.value) preview.src = orig.value;

    fileInput.addEventListener('change', function (e) {
        const f = this.files && this.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            const dataUrl = ev.target.result;
            preview.src = dataUrl;
            orig.value = dataUrl;
            db.settings.logo = dataUrl;
            document.getElementById('printLogo').src = dataUrl;
        };
        reader.readAsDataURL(f);
    });

    orig.parentNode.insertBefore(container, orig.nextSibling);
    container.appendChild(fileInput);
    container.appendChild(preview);
    container.appendChild(removeBtn);
}

function switchTab(tabId) {
    const tab = document.getElementById(tabId);
    const navBtn = document.querySelector(`.nav-btn[data-target="${tabId}"]`);
    if (!tab || !navBtn) return;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    tab.classList.add('active');
    navBtn.classList.add('active');
    localStorage.setItem('appCurrentTab', tabId);
}

function exportDB() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(db));
    const dl = document.createElement('a'); dl.setAttribute("href", dataStr); dl.setAttribute("download", "backup.json"); dl.click();
}

function importDB() {
    const file = document.getElementById('importFile').files[0];
    if (!file) return alert('اختر ملف');
    const reader = new FileReader();
    reader.onload = function (e) { try { db = JSON.parse(e.target.result); saveDB(); alert('تمت الاستعادة'); } catch (err) { alert('خطأ في الملف'); } };
    reader.readAsText(file);
}

function loadLoginState() {
    localStorage.removeItem('appRememberUsername');
    localStorage.removeItem('appRememberPassword');
    localStorage.setItem('appRememberChecked', 'false');
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('rememberPassword').checked = false;
}

function showLogin(message) {
    document.getElementById('loginMessage').innerText = message || '';
    document.getElementById('licenseScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
}

function showApp() {
    document.getElementById('licenseScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appRoot').style.display = 'block';
    initDates();
    renderAll();
    const savedTab = localStorage.getItem('appCurrentTab') || 'tab-main';
    const tabKey = savedTab.replace('tab-', '');
    if (canViewTab(tabKey)) switchTab(savedTab);
}

function logout() {
    currentUser = null;
    localStorage.removeItem('appAccessToken');
    localStorage.removeItem('appCurrentUserId');
    const loginSelect = document.getElementById('currentUserSelect');
    if (loginSelect) { loginSelect.value = ''; loginSelect.disabled = false; }
    const displaySpan = document.getElementById('currentUserDisplay');
    if (displaySpan) displaySpan.style.display = 'none';
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('rememberPassword').checked = false;
    showLogin();
}

async function login() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const remember = document.getElementById('rememberPassword').checked;
    if (!username || !password) return showLogin('يرجى إدخال اسم المستخدم وكلمة المرور');
    try {
        localStorage.removeItem('appAccessToken');
        localStorage.removeItem('appCurrentUserId');
        const result = await apiRequest(API_ROUTES.login, {
            method: 'POST',
            auth: false,
            body: JSON.stringify({ username, password })
        });
        currentUser = result.user;
        localStorage.setItem('appAccessToken', result.access_token);
        localStorage.setItem('appCurrentUserId', currentUser.id);
        localStorage.removeItem('appRememberUsername');
        localStorage.removeItem('appRememberPassword');
        localStorage.setItem('appRememberChecked', remember ? 'true' : 'false');
        await loadRemoteState();
        currentUser = db.users.find(user => user.id === result.user.id) || result.user;
        showApp();
    } catch (error) {
        console.error('Login failed:', error);
        localStorage.removeItem('appAccessToken');
        localStorage.removeItem('appCurrentUserId');
        const message = error.message === 'Failed to fetch'
            ? 'تعذر الاتصال بخادم Frappe.'
            : (error.message || 'تعذر تسجيل الدخول. تأكد من اسم المستخدم وكلمة المرور ثم حاول مرة أخرى.');
        showLogin(message);
    }
}

function forgotPassword() {
    alert('يرجى التواصل مع مدير النظام لإعادة تعيين كلمة المرور أو تحديث بيانات المستخدم.');
}

async function bootApp() {
    try {
        const license = await getLicenseStatus();
        if (!license.active) {
            showLicense(license.message);
            return;
        }
        loadLoginState();
        const savedUserId = localStorage.getItem('appCurrentUserId');
        const savedToken = localStorage.getItem('appAccessToken');
        if (savedToken && savedUserId) {
            try {
                await loadRemoteState();
                const savedUser = db.users.find(user => user.id === savedUserId);
                if (savedUser) {
                    currentUser = savedUser;
                    showApp();
                    return;
                }
            } catch (sessionError) {
                console.warn('Saved Tageep session is no longer valid:', sessionError);
            }
        }
        localStorage.removeItem('appAccessToken');
        localStorage.removeItem('appCurrentUserId');
        showLogin();
    } catch (error) {
        console.error('API load failed:', error);
        const local = localStorage.getItem('tageep_state');
        if (local) {
            try {
                normalizeAppState(JSON.parse(local));
                if (!Array.isArray(db.users) || db.users.length === 0) {
                    db.users = [{ id: 'u_admin', name: 'مدير النظام', password: '', role: 'admin', branchId: 'all', allowedTabs: {}, tabPermissions: {} }];
                }
                const savedUserId = localStorage.getItem('appCurrentUserId');
                currentUser = db.users.find(u => u.id === savedUserId) || db.users[0] || null;
                showApp();
                return;
            } catch (e) {
                console.error('Failed to load local state fallback:', e);
            }
        }
        document.body.innerHTML = `
            <div style="direction:rtl; font-family:Tahoma, sans-serif; max-width:720px; margin:60px auto; padding:24px; background:#fff; border:1px solid #ddd; border-radius:8px;">
                <h2 style="color:#c0392b;">تعذر الاتصال بالباكند</h2>
                <p>تأكد أن خادم Frappe يعمل وأن تطبيق tageep مثبت على الموقع، ثم أعد تحميل الصفحة.</p>
                <p>رابط اختبار API: /api/method/tageep.api.license_status</p>
            </div>
        `;
    }
}

function enableTableSorting() {
    // no-op placeholder (optional)
}

function wrapTablesWithScroll() {
    document.querySelectorAll('.tab-content table').forEach(table => {
        if (!table.parentElement.classList.contains('table-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'table-wrapper';
            table.parentNode.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        }
    });
}

document.addEventListener('DOMContentLoaded', wrapTablesWithScroll);

// Boot
bootApp();