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
let remoteSavePending = false;
let remoteSavePromise = null;

let db = {
    settings: { companyName: 'الشركة', logo: '', weeklyOffDays: ['5'], operationalDayStart: '06:00' },
    branches: [{ id: 'b1', name: 'المركز الرئيسي' }],
    users: [],
    employees: [],
    absences: [], // {id, empId, date, value, type:'absent'|'annual'|'holiday_present'}
    dailyFollowUps: [], // {id, empId, branchId, date, statusType, value, notes, createdAt}
    dailyExtras: [], // {id, empId, date, amount, notes, createdAt}
    // تعديل جديد: قائمة السلف اليومية، بنفس بنية الإضافي تقريباً.
    // الكود الأصلي لم يكن يحتوي على dailyAdvances.
    dailyAdvances: [], // {id, empId, date, amount, notes, createdAt}
    archivedReports: [], // {id, branchId, branchName, date, createdAt, entries, fileName}
    sentReports: [], // {id, branchId, branchName, date, createdAt, entries, status:'pending'|'transferred'}
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
        // تعديل جديد: تطبيع السلف عند تحميل الحالة من السيرفر أو localStorage.
        // الكود الأصلي معطل: لم تكن هناك dailyAdvances ضمن normalizeAppState.
        dailyAdvances: (data.dailyAdvances || []).map(item => ({
            ...item,
            amount: parseFloat(item.amount) || 0
        })),
        archivedReports: data.archivedReports || [],
        sentReports: data.sentReports || [],
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

// تعديل جديد: تعريف مركزي لأنواع حالات التعقيب حتى تشمل "إجازة أخرى".
// الكود الأصلي معطل: كان يكرر شروطاً ثلاثية في عدة أماكن بدون other_leave.
const DAILY_STATUS_OPTIONS = ['present', 'absent', 'annual', 'other_leave', 'holiday_present'];
const DAILY_STATUS_LABELS = {
    present: 'حاضر',
    absent: 'غائب',
    annual: 'إجازة سنوية',
    other_leave: 'إجازة أخرى',
    holiday_present: 'مناسبة'
};

function getDailyStatusLabel(statusType) {
    return DAILY_STATUS_LABELS[statusType] || statusType || '';
}

function getLeaveDeductionValue(statusType, period) {
    if (statusType !== 'annual' && statusType !== 'other_leave') return 0;
    return (!period || period === 'all') ? 1 : 0.5;
}

function buildDailyStatusOptions(selectedStatus) {
    return DAILY_STATUS_OPTIONS
        .map(status => `<option value="${status}" ${selectedStatus === status ? 'selected' : ''}>${getDailyStatusLabel(status)}</option>`)
        .join('');
}

// دالة مساعدة: ترجع الموظفين المقيدين بفرع معين، أو كل الموظفين إذا كان الفرع 'all'
function getFilteredEmployeesByBranch(branchId) {
    if (!branchId || branchId === 'all' || branchId === '') return db.employees;
    return (db.employees || []).filter(e => e.branchId === branchId);
}

// Enhanced saveDB with auto-refresh
function saveDB(options = {}) {
    try {
        localStorage.setItem('tageep_state', JSON.stringify(db));
    } catch (e) {
        console.warn('saveDB: local save failed', e);
    }
    // Try to persist to remote in background; don't block UI
    const remoteSave = persistRemoteState().catch(err => { console.warn('saveDB: remote persist failed', err); });
    // Auto-refresh the current view immediately
    refreshCurrentView();
    return options.waitRemote ? remoteSave : undefined;
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
            // تعديل جديد: تحديث جدول السلف عند تحديث تبويب التعقيب اليومي.
            // الكود الأصلي كان يحدث التعقيب اليومي والإضافي فقط.
            renderDailyAdvances();
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
        case 'tab-archive':
            renderArchiveReports();
            break;
        case 'tab-sent':
            renderSentReports();
            break;
    }
}

// تحديث جميع القوائم المنسدلة
function refreshAllDropdowns() {
    // Employee selects - تصفية حسب الفرع المحدد
    const currentBranchVal = document.getElementById('dailyBranch')?.value || 'all';
    const currentFilterBranchVal = document.getElementById('dailyFilterBranch')?.value || 'all';
    const currentEmps = getFilteredEmployeesByBranch(currentBranchVal);
    const currentFilterEmps = getFilteredEmployeesByBranch(currentFilterBranchVal);

    // تعبئة قائمة الموظفين في نموذج الإضافة (مرتبطة بـ dailyBranch)
    const dailyEmpEl = document.getElementById('dailyEmp');
    if (dailyEmpEl) {
        const savedValue = dailyEmpEl.value;
        dailyEmpEl.innerHTML = '<option value="">اختر موظفاً</option>';
        currentEmps.forEach(e => {
            dailyEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentEmps.find(e => e.id === savedValue)) {
            dailyEmpEl.value = savedValue;
        }
    }

    // تعبئة قائمة الموظفين في فلتر التعقيب اليومي (مرتبطة بـ dailyFilterBranch)
    const dailyFilterEmpEl = document.getElementById('dailyFilterEmp');
    if (dailyFilterEmpEl) {
        const savedValue = dailyFilterEmpEl.value;
        dailyFilterEmpEl.innerHTML = '<option value="all">الكل</option>';
        currentFilterEmps.forEach(e => {
            dailyFilterEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentFilterEmps.find(e => e.id === savedValue)) {
            dailyFilterEmpEl.value = savedValue;
        }
    }

    // تعبئة قائمة الموظفين في الإضافي (مرتبطة بـ dailyBranch)
    const extraEmpEl = document.getElementById('extraEmp');
    if (extraEmpEl) {
        const savedValue = extraEmpEl.value;
        extraEmpEl.innerHTML = '<option value="">اختر موظفاً</option>';
        currentEmps.forEach(e => {
            extraEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentEmps.find(e => e.id === savedValue)) {
            extraEmpEl.value = savedValue;
        }
    }

    // تعبئة قائمة الموظفين في فلتر الإضافي (مرتبطة بـ dailyFilterBranch)
    const extraFilterEmpEl = document.getElementById('extraFilterEmp');
    if (extraFilterEmpEl) {
        const savedValue = extraFilterEmpEl.value;
        extraFilterEmpEl.innerHTML = '<option value="all">الكل</option>';
        currentFilterEmps.forEach(e => {
            extraFilterEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentFilterEmps.find(e => e.id === savedValue)) {
            extraFilterEmpEl.value = savedValue;
        }
    }

    // تعديل جديد: تعبئة قائمة الموظفين في السلف (مرتبطة بـ dailyBranch).
    // الكود الأصلي معطل: كان يدعم قوائم الإضافي فقط.
    const advanceEmpEl = document.getElementById('advanceEmp');
    if (advanceEmpEl) {
        const savedValue = advanceEmpEl.value;
        advanceEmpEl.innerHTML = '<option value="">اختر موظفاً</option>';
        currentEmps.forEach(e => {
            advanceEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentEmps.find(e => e.id === savedValue)) {
            advanceEmpEl.value = savedValue;
        }
    }

    // تعديل جديد: تعبئة قائمة فلتر السلف (مرتبطة بـ dailyFilterBranch).
    const advanceFilterEmpEl = document.getElementById('advanceFilterEmp');
    if (advanceFilterEmpEl) {
        const savedValue = advanceFilterEmpEl.value;
        advanceFilterEmpEl.innerHTML = '<option value="all">الكل</option>';
        currentFilterEmps.forEach(e => {
            advanceFilterEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedValue && currentFilterEmps.find(e => e.id === savedValue)) {
            advanceFilterEmpEl.value = savedValue;
        }
    }

    // تعبئة قائمة الموظفين في فلتر الإيضاحي (كل الموظفين)
    const summaryEmpEl = document.getElementById('summaryEmp');
    if (summaryEmpEl) {
        const savedVal = summaryEmpEl.value;
        summaryEmpEl.innerHTML = '<option value="all">الكل</option>';
        db.employees.forEach(e => {
            summaryEmpEl.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedVal && db.employees.find(e => e.id === savedVal)) {
            summaryEmpEl.value = savedVal;
        }
    }

    // تحديد الفروع حسب المستخدم
    const isBranchUser = currentUser && currentUser.role !== 'admin';
    const userBranchId = isBranchUser ? currentUser.branchId : null;
    const empsForBranches = isBranchUser && userBranchId ? db.branches.filter(b => b.id === userBranchId) : db.branches;

    // Branch selects
    const branchSelects = [
        document.getElementById('empBranch'),
        document.getElementById('empFilterBranch'),
        document.getElementById('filterBranch'),
        document.getElementById('userBranch'),
        document.getElementById('dailyBranch'),
        document.getElementById('dailyFilterBranch'),
        document.getElementById('archiveFilterBranch'),
        document.getElementById('reportBranch'),
        document.getElementById('sentFilterBranch'),
        document.getElementById('summaryBranch')
    ];
    branchSelects.forEach(select => {
        if (!select) return;
        const savedValue = select.value;
        const isFilter = select.id === 'filterBranch' || select.id === 'userBranch' || select.id === 'dailyFilterBranch' || select.id === 'archiveFilterBranch' || select.id === 'reportBranch' || select.id === 'empFilterBranch';
        select.innerHTML = isFilter ? '<option value="all">الكل</option>' : '';
        empsForBranches.forEach(b => {
            select.innerHTML += `<option value="${b.id}">${b.name}</option>`;
        });
        if (savedValue && empsForBranches.find(b => b.id === savedValue)) {
            select.value = savedValue;
        }
        if (isBranchUser && empsForBranches.length === 1) {
            select.value = empsForBranches[0].id;
            select.disabled = true;
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
            // إذا كانت القيمة أقل من 1 (مثلاً 0.5 لنصف يوم)، نطبق الحالة على عدد متناسب من الفترات فقط
            const val = parseFloat(mainRec.value) || 1;
            const periodsToSet = Math.round(val * N);
            for (let i = 0; i < Math.min(periodsToSet, N); i++) {
                status[i] = t;
            }
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
    let otherLeaveDays = 0;
    let holidayPresent = 0;
    const holidaysSet = new Set((db.holidays || []).filter(h => h.date >= from && h.date <= to).map(h => h.date));
    workingDates.forEach(date => {
        const statusArr = getDailyStatusArray(emp, date);
        const N = statusArr.length || 1;
        let absentCount = 0, annualCount = 0, otherLeaveCount = 0, holidayCount = 0;
        statusArr.forEach(s => {
            if (s === 'absent') absentCount++;
            if (s === 'annual') annualCount++;
            if (s === 'other_leave') otherLeaveCount++;
            if (s === 'holiday_present') holidayCount++;
        });

        if (holidayCount === N && holidaysSet.has(date)) {
            holidayPresent += 1;
            return;
        }
        // حساب الغياب والإجازات السنوية والإجازة الأخرى منفصلين
        absenceDays += absentCount / N;
        annualDays += annualCount / N;
        otherLeaveDays += otherLeaveCount / N;
    });
    return { absenceDays, annualDays, otherLeaveDays, holidayPresent };
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
    if (isSavingRemote) {
        remoteSavePending = true;
        return remoteSavePromise;
    }
    isSavingRemote = true;
    remoteSavePromise = (async () => {
        try {
            do {
                remoteSavePending = false;
                const state = await apiRequest(API_ROUTES.saveState, {
                    method: 'POST',
                    body: JSON.stringify({ state: db })
                });
                if (!remoteSavePending) {
                    normalizeAppState(state);
                }
                backendAvailable = true;
                console.info('State persisted to backend successfully.');
            } while (remoteSavePending);
        } catch (error) {
            backendAvailable = false;
            console.warn('API save failed:', error);
            if (getAccessToken()) {
                alert(`تعذر حفظ البيانات في قاعدة بيانات Frappe.\n${error.message || ''}`);
            }
        } finally {
            isSavingRemote = false;
            remoteSavePending = false;
            remoteSavePromise = null;
        }
    })();
    return remoteSavePromise;
}

async function getLicenseStatus() {
    return { active: true, message: '' };
}

function showLicense(message) {
    const bootScreen = document.getElementById('bootScreen');
    if (bootScreen) bootScreen.style.display = 'none';
    document.getElementById('licenseMessage').innerText = message || '';
    document.getElementById('licenseScreen').style.display = 'flex';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appRoot').style.display = 'none';
}

async function activateLicense() {
    loadLoginState();
    showLogin('');
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
                labelEl.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    selectItem(val, text);
                });
                labelEl.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    selectItem(val, text);
                });
                labelEl.addEventListener('mouseenter', function () {
                    this.style.background = '#e8f0fe';
                });
                labelEl.addEventListener('mouseleave', function () {
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
    input.addEventListener('focus', function () {
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
    input.addEventListener('input', function () {
        dropdown.style.display = 'block';
        updateDropdown(this.value);
    });

    // إخفاء القائمة عند فقدان التركيز
    input.addEventListener('blur', function () {
        setTimeout(() => {
            dropdown.style.display = 'none';
            const selectedOpt = selectEl.options[selectEl.selectedIndex];
            if (selectedOpt && selectedOpt.value) {
                input.value = selectedOpt.text;
            }
        }, 300);
    });

    // مفتاح ESC لإغلاق القائمة
    input.addEventListener('keydown', function (e) {
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
    selectEl.addEventListener('change', function () {
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
        // تعديل جديد: إضافة قوائم السلف للبحث مثل قوائم الإضافي.
        // الكود الأصلي معطل: 'dailyEmp', 'dailyFilterEmp', 'extraEmp', 'extraFilterEmp',
        'dailyEmp', 'dailyFilterEmp', 'extraEmp', 'extraFilterEmp', 'advanceEmp', 'advanceFilterEmp',
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
        // إزالة أيقونات العين (👁️) من الطباعة
        tableClone.querySelectorAll('.col-toggle-btn').forEach(el => el.remove());
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
                    margin: 2mm; 
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
                    font-weight: 800;

                }
                .employee-name,
                .branch-name {
                    white-space: nowrap !important;
                    word-break: keep-all !important;
                    overflow-wrap: normal !important;
                }
                .employee-name { min-width: 120px; }
                .branch-name { min-width: 100px; }
                    
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

        // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>طباعة - تقرير التعقيب</title>
    ${printStyles}
</head>
<body>
    ${finalHtmlWithFooter}
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
        iframeDoc.write(printContent);
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
        // إزالة أيقونات العين (👁️) من الطباعة
        tableClone.querySelectorAll('.col-toggle-btn').forEach(el => el.remove());
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
            ? `<img src="${logoUrl}" style="width:90%;height:auto;object-fit:fill;display:block;margin:0;padding:0;" alt="شعار الشركة">`
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
                    margin: 2mm; 
                }
                body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
                table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
                th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
                .employee-name,
                .branch-name {
                    white-space: nowrap !important;
                    word-break: keep-all !important;
                    overflow-wrap: normal !important;
                }
                .employee-name { min-width: 120px; }
                .branch-name { min-width: 100px; }
                th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
                thead { display: table-header-group; }
                thead th, thead td { position: static !important; }
                thead img { max-height: 40px !important; }
                tr { page-break-inside: auto; break-inside: auto; }
                tbody tr { orphans: 2; widows: 2; }
                .state-absent { background: #ff0000 !important; color: #ffffff !important; font-weight: 700 !important; }
                .state-annual { background: #e67e22 !important; color: #ffffff !important; font-weight: 700 !important; }
                .state-present { background: #e8f5e9 !important; color: #1b5e20 !important; font-weight: 700 !important; }
                .state-holiday { background: #e3f2fd !important; color: #1565c0 !important; font-weight: 700 !important; }
                table, table th, table td { font-weight: 800 !important; }
                @media print { .state-absent, .state-annual, .state-present, .state-holiday { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }
            </style>
        `;

        const tableHtml = tableClone.outerHTML;
        const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

        // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>طباعة - تقرير التعقيب</title>
    ${printStyles}
</head>
<body>
    ${finalHtmlWithFooter}
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
                } catch (e) {
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

        printWindow.onload = function () {
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
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    document.getElementById('filterTo').value = today.toISOString().split('T')[0];
    document.getElementById('filterFrom').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('empDate').value = today.toISOString().split('T')[0];
    document.getElementById('dailyDate').value = today.toISOString().split('T')[0];
    document.getElementById('extraDate').value = today.toISOString().split('T')[0];
    // تعديل جديد: تهيئة تاريخ السلفة بنفس تهيئة تاريخ الإضافي.
    // الكود الأصلي لم يكن يحتوي على حقول advanceDate.
    const advanceDate = document.getElementById('advanceDate');
    if (advanceDate) advanceDate.value = today.toISOString().split('T')[0];
    document.getElementById('dailyFilterTo').value = today.toISOString().split('T')[0];
    document.getElementById('dailyFilterFrom').value = lastWeek.toISOString().split('T')[0];
    document.getElementById('extraFilterTo').value = today.toISOString().split('T')[0];
    document.getElementById('extraFilterFrom').value = lastWeek.toISOString().split('T')[0];
    // تعديل جديد: فلاتر السلف الافتراضية بنفس نطاق الإضافي.
    const advanceFilterTo = document.getElementById('advanceFilterTo');
    const advanceFilterFrom = document.getElementById('advanceFilterFrom');
    if (advanceFilterTo) advanceFilterTo.value = today.toISOString().split('T')[0];
    if (advanceFilterFrom) advanceFilterFrom.value = lastWeek.toISOString().split('T')[0];
    const reportFrom = document.getElementById('reportFrom');
    const reportTo = document.getElementById('reportTo');
    if (reportFrom) reportFrom.value = lastWeek.toISOString().split('T')[0];
    if (reportTo) reportTo.value = today.toISOString().split('T')[0];
    // تعيين فلاتر التاريخ في صفحة الأرشفة (التعقيب المؤرشيف والمرسل) افتراضياً:
    // من يوم أمس إلى اليوم الحالي
    const archiveFilterFrom = document.getElementById('archiveFilterFrom');
    const archiveFilterTo = document.getElementById('archiveFilterTo');
    if (archiveFilterFrom) archiveFilterFrom.value = yesterday.toISOString().split('T')[0];
    if (archiveFilterTo) archiveFilterTo.value = today.toISOString().split('T')[0];
    const sentFilterFrom = document.getElementById('sentFilterFrom');
    const sentFilterTo = document.getElementById('sentFilterTo');
    if (sentFilterFrom) sentFilterFrom.value = yesterday.toISOString().split('T')[0];
    if (sentFilterTo) sentFilterTo.value = today.toISOString().split('T')[0];
    // تعبئة قائمة السنوات وتعيين الشهر الحالي للتقرير
    populateReportYearSelect();
    const currentMonth = String(today.getMonth() + 1);
    const monthEl = document.getElementById('reportMonth');
    if (monthEl) monthEl.value = currentMonth;
    const yearEl = document.getElementById('reportYear');
    if (yearEl) yearEl.value = String(today.getFullYear());
    // تحديث حقلي التاريخ بناءً على الشهر الحالي
    if (monthEl && yearEl) reportMonthChanged();
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
    } else if (panelId === 'summary-panel') {
        renderSummaryTable();
    }
    // إعادة تفعيل إظهار/إخفاء الأعمدة بعد التبديل
    setTimeout(enableColumnToggleForAllTables, 100);
}

function addOrReplaceAbsenceRecord(newRec) {
    const emp = findEmployeeById(newRec.empId);
    const existing = db.absences.find(a => a.empId === newRec.empId && a.date === newRec.date);
    if (existing) {
        if (existing.type === 'annual' && emp) {
            emp.leaveBalance = parseFloat(emp.leaveBalance) + parseFloat(existing.value || 1);
        }
        db.absences = db.absences.filter(a => !(a.empId === newRec.empId && a.date === newRec.date));
    }
    if (newRec.type === 'annual' && emp) {
        emp.leaveBalance = parseFloat(emp.leaveBalance) - parseFloat(newRec.value || 1);
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

    // تحديد قائمة الفروع حسب صلاحية المستخدم
    const isManagerUser = currentUser && currentUser.role !== 'admin';
    const userBranchId = isManagerUser ? currentUser.branchId : null;
    const getBranchesForUser = () => {
        if (userBranchId) return db.branches.filter(b => b.id === userBranchId);
        return db.branches;
    };
    const userBranches = getBranchesForUser();

    // Populate all dropdowns - فقط الفروع المسموحة للمستخدم
    const branchSelects = [
        document.getElementById('empBranch'),
        document.getElementById('empFilterBranch'),
        document.getElementById('filterBranch'),
        document.getElementById('userBranch'),
        document.getElementById('dailyBranch'),
        document.getElementById('dailyFilterBranch'),
        document.getElementById('archiveFilterBranch'),
        document.getElementById('summaryBranch')
    ];
    branchSelects.forEach(select => {
        if (!select) return;
        const isFilter = select.id === 'filterBranch' || select.id === 'userBranch' || select.id === 'dailyFilterBranch' || select.id === 'archiveFilterBranch' || select.id === 'empFilterBranch';
        select.innerHTML = isFilter ? '<option value="all">الكل</option>' : '';
        userBranches.forEach(b => select.innerHTML += `<option value="${b.id}">${b.name}</option>`);
        if (isManagerUser && userBranches.length === 1) {
            select.value = userBranches[0].id;
            select.disabled = true;
        }
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

    // Populate sentFilterBranch dropdown
    const sentFilterBranch = document.getElementById('sentFilterBranch');
    if (sentFilterBranch) {
        const savedVal = sentFilterBranch.value;
        sentFilterBranch.innerHTML = '<option value="all">الكل</option>';
        userBranches.forEach(b => {
            sentFilterBranch.innerHTML += `<option value="${b.id}">${b.name}</option>`;
        });
        sentFilterBranch.value = userBranches.find(b => b.id === savedVal) ? savedVal : 'all';
        if (isManagerUser && userBranches.length === 1) {
            sentFilterBranch.value = userBranches[0].id;
            sentFilterBranch.disabled = true;
        }
    }

    // دالة لتعبئة قوائم الموظفين بناءً على الفرع المحدد
    function populateEmployeeSelects() {
        const dailyBranchVal = document.getElementById('dailyBranch').value;
        const filteredEmps = getFilteredEmployeesByBranch(dailyBranchVal);

        document.getElementById('dailyEmp').innerHTML = `<option value="">اختر موظفاً</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        const dailyEmpEl = document.getElementById('dailyEmp');
        if (dailyEmpEl) {
            dailyEmpEl.onchange = function () { populateDailyPeriodOptions(this.value); };
        }
        document.getElementById('dailyFilterEmp').innerHTML = `<option value="all">الكل</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        document.getElementById('extraEmp').innerHTML = `<option value="">اختر موظفاً</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        document.getElementById('extraFilterEmp').innerHTML = `<option value="all">الكل</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        // تعديل جديد: تعبئة قوائم السلف بنفس مصدر قوائم الإضافي.
        // الكود الأصلي لم يكن يحتوي على advanceEmp أو advanceFilterEmp.
        const advanceEmp = document.getElementById('advanceEmp');
        const advanceFilterEmp = document.getElementById('advanceFilterEmp');
        if (advanceEmp) advanceEmp.innerHTML = `<option value="">اختر موظفاً</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        if (advanceFilterEmp) advanceFilterEmp.innerHTML = `<option value="all">الكل</option>` + filteredEmps.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    }

    populateEmployeeSelects();

    // تعبئة قائمة الموظفين في فلتر الإيضاحي
    const summaryEmpRender = document.getElementById('summaryEmp');
    if (summaryEmpRender) {
        const savedVal = summaryEmpRender.value;
        summaryEmpRender.innerHTML = '<option value="all">الكل</option>';
        db.employees.forEach(e => {
            summaryEmpRender.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
        if (savedVal && db.employees.find(e => e.id === savedVal)) {
            summaryEmpRender.value = savedVal;
        }
    }

    // عند تغيير الفرع في التعقيب اليومي، تحديث قوائم الموظفين
    const dailyBranchEl = document.getElementById('dailyBranch');
    if (dailyBranchEl) {
        dailyBranchEl.onchange = function () {
            populateEmployeeSelects();
        };
    }
    document.getElementById('empFilterBranch').innerHTML = `<option value="all">الكل</option>` + userBranches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    const reportBranch = document.getElementById('reportBranch');
    if (reportBranch) {
        reportBranch.innerHTML = `<option value="all">الكل</option>` + userBranches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
        if (isManagerUser && userBranches.length === 1) {
            reportBranch.value = userBranches[0].id;
            reportBranch.disabled = true;
        }
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
        // تم ضبط قيمة filterBranch أعلاه في حلقة branchSelects
        const fb = document.getElementById('filterBranch');
        if (fb) { /* لا نقوم بإعادة التعيين */ }
    }

    document.querySelectorAll('.nav-btn').forEach(el => {
        const target = el.dataset.target;
        let tabKey = '';
        switch (target) {
            case 'tab-main': tabKey = 'main'; break;
            case 'tab-daily': tabKey = 'daily'; break;
            case 'tab-archive': tabKey = 'archive'; break;
            case 'tab-sent': tabKey = 'archive'; break;
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

    // تم تعطيل الفروع للمستخدمين العاديين أعلاه في حلقة branchSelects.
    // الكود القديم أدناه تم استبداله - لم نعد نحتاج لإعادة تعيين الفروع هنا.

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

    // تعديل جديد: إضافة حقول السلف إلى عناصر التحكم الخاصة بصلاحيات التعقيب اليومي.
    // الكود الأصلي معطل:
    // const dailyControls = ['dailyBranch', 'dailyEmp', 'dailyDate', 'dailyStatus', 'dailyValue', 'dailyNotes', 'btnSaveDaily', 'extraEmp', 'extraDate', 'extraAmount', 'extraNotes', 'btnSaveExtra'];
    const dailyControls = ['dailyBranch', 'dailyEmp', 'dailyDate', 'dailyStatus', 'dailyValue', 'dailyNotes', 'btnSaveDaily', 'extraEmp', 'extraDate', 'extraAmount', 'extraNotes', 'btnSaveExtra', 'advanceEmp', 'advanceDate', 'advanceAmount', 'advanceNotes', 'btnSaveAdvance'];
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
    // تعديل جديد: رسم جدول السلف مع بقية جداول التعقيب اليومي.
    renderDailyAdvances();
    renderArchiveReports();
    renderSentReports();
    renderHolidays();
    renderWorkShifts();
    renderShiftPeriods();
    renderReportTable();
    enableTableSorting();

    // Enable search on all selects after rendering
    setTimeout(enableSearchableSelects, 100);

    // Enable column toggle for main and report tables
    setTimeout(enableColumnToggleForAllTables, 200);
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

// --- تعديل جديد: التحقق من نطاق التاريخ (حد أقصى شهر واحد = 31 يوم) ---
// تم إضافة هذا التعديل مع الحفاظ على الكود الأصلي (معطل بالتعليقات)
const MAX_DATE_RANGE_CALENDAR_DAYS = 31; // أقصى نطاق مسموح به بالتقويم (وليس أيام العمل)

// دالة للتحقق من نطاق التاريخ وإرجاع التاريخ المعدل إذا تجاوز الحد
// ملاحظة: هذه الدالة جديدة وتمت إضافتها كتعديل (الكود الأصلي لم يكن يحتوي عليها)
function validateMainDateRange(from, to) {
    // إذا كان أحد التاريخين فارغاً، لا داعي للتحقق
    if (!from || !to) return { from, to };

    const fromDate = new Date(from);
    const toDate = new Date(to);

    // حساب الفرق بالأيام (بالأيام التقويمية، وليس أيام العمل)
    const diffTime = Math.abs(toDate - fromDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // إذا تجاوز النطاق الشهر (31 يوم)، نقوم بقص التاريخ "إلى" وجعله 31 يوماً فقط
    if (diffDays > MAX_DATE_RANGE_CALENDAR_DAYS) {
        // حساب التاريخ الجديد: من + 31 يوم
        const newToDate = new Date(fromDate);
        newToDate.setDate(newToDate.getDate() + MAX_DATE_RANGE_CALENDAR_DAYS);
        const newTo = newToDate.toISOString().split('T')[0];

        // تنبيه المستخدم - هذا هو التعديل على السلوك الأصلي
        alert(`⚠️ تم تحديد نطاق تاريخ ${diffDays} يوم، وهو يتجاوز الحد الأقصى المسموح به (شهر واحد = ${MAX_DATE_RANGE_CALENDAR_DAYS} يوم).\nتم تقليص التاريخ "إلى" تلقائياً إلى ${newTo}.`);

        return { from, to: newTo };
    }

    return { from, to };
}

function renderMainTable() {
    const tbody = document.getElementById('mainTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const branchId = document.getElementById('filterBranch').value;
    const nameFilter = normalizeText(document.getElementById('filterName').value);
    let from = document.getElementById('filterFrom').value;
    let to = document.getElementById('filterTo').value;

    // ===== التعديل الجديد: التحقق من نطاق التاريخ (الحد الأقصى شهر واحد) =====
    // الكود الأصلي: كان يستخدم from و to مباشرة دون تحقق من النطاق
    // if (from && to) { ... } - لم يكن هناك تحقق

    // تطبيق التحقق على نطاق التاريخ
    const validatedRange = validateMainDateRange(from, to);
    from = validatedRange.from;
    to = validatedRange.to;

    // تحديث حقول التاريخ بالقيم المعدلة (إن وجد تعديل)
    if (from !== document.getElementById('filterFrom').value) {
        document.getElementById('filterFrom').value = from;
    }
    if (to !== document.getElementById('filterTo').value) {
        document.getElementById('filterTo').value = to;
    }
    // ===== نهاية التعديل =====

    // ===== التعديل الجديد: إنشاء أعمدة التاريخ ديناميكياً (بدلاً من الأعمدة الـ 7 الثابتة) =====
    // الكود الأصلي: كان يعتمد على 7 خلايا <th class="dyn-date"> في HTML ويعرض/يخفي حسب الحاجة
    // تم استبداله بإنشاء الخلايا ديناميكياً بعدد أيام العمل الفعلية
    const headerRow = document.getElementById('mainTableHeaderRow');
    const dateRange = getWorkingDatesBetween(from, to, 31);
    const workingDates = dateRange.length > 0 ? dateRange : [new Date().toISOString().split('T')[0]];

    if (headerRow) {
        // إزالة الخلايا الديناميكية القديمة إن وجدت
        const existingDynamicCells = headerRow.querySelectorAll('.dyn-date-cell');
        existingDynamicCells.forEach(cell => cell.remove());

        // تعديل جديد: بعد نقل "الأجر اليومي" وإضافة "اجمالي المبلغ المتوقع"،
        // أصبحت أعمدة التاريخ تبدأ قبل عمود "أيام الغياب" عند index 8.
        // الكود الأصلي معطل: كان يستخدم index 6 قبل إضافة الأعمدة الجديدة.
        // const insertBeforeCell = headerRow.children[6]; // العمود "أيام الغياب" سابقاً
        const insertBeforeCell = headerRow.children[8]; // العمود "أيام الغياب" بعد التعديل
        workingDates.forEach((dateStr, idx) => {
            const th = document.createElement('th');
            th.className = 'dyn-date-cell dyn-date'; // dyn-date للتوافق مع makeTableSortable
            // استخراج رقم اليوم والشهر من السلسلة النصية مباشرة لتجنب مشاكل التوقيت (timezone)
            const parts = dateStr.split('-'); // YYYY-MM-DD
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1; // 0-indexed
            const day = parseInt(parts[2], 10);
            const dateObj = new Date(year, month, day); // Local timezone
            // عرض اسم اليوم (رمز الأيام) + التاريخ
            const dayName = getDayName(dateStr, true);
            th.innerText = `${dateObj.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })} ${dayName}`;
            th.dataset.date = dateStr;
            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            th.title = 'انقر للفرز';

            // إضافة سهم الفرز
            const arrow = document.createElement('span');
            arrow.className = 'sort-arrow';
            arrow.style.cssText = 'margin-right:4px;font-size:11px;color:#888;';
            arrow.textContent = ' ⇅';
            th.appendChild(arrow);

            // إدراج الخلية قبل العمود الثابت "أيام الغياب" لضمان ترتيب تصاعدي صحيح
            if (insertBeforeCell && headerRow) {
                headerRow.insertBefore(th, insertBeforeCell);
            }
        });
    }

    // حساب العدد الإجمالي للأعمدة (لـ colspan)
    // الكود الأصلي معطل:
    // const TOTAL_BASE_COLS_BEFORE = 6; // م, رقم الموظف, الاسم, الفرع, الرصيد, المتوقعة
    // const TOTAL_BASE_COLS_AFTER = 7;  // الغياب, الإجازات, الفعلية, الأجر, الإضافي, الصافي, الإجراءات
    // تعديل جديد: نقل "الأجر اليومي" قبل الأيام المتوقعة، وإضافة "اجمالي المبلغ المتوقع".
    // الكود الأصلي معطل بعد إضافة عمودي "اجمالي المبلغ الفعلي" و"السلف":
    // const TOTAL_BASE_COLS_AFTER = 6;  // الغياب, الإجازات, الفعلية, الإضافي, الصافي, الإجراءات
    const TOTAL_BASE_COLS_BEFORE = 8; // م, رقم الموظف, الاسم, الفرع, الرصيد, الأجر, المتوقعة, إجمالي المتوقع
    const TOTAL_BASE_COLS_AFTER = 9;  // الغياب, الإجازات, الإجازة الأخرى, الفعلية, إجمالي الفعلي, السلف, الإضافي, الصافي, الإجراءات
    const totalCols = TOTAL_BASE_COLS_BEFORE + workingDates.length + TOTAL_BASE_COLS_AFTER;
    // ===== نهاية التعديل =====

    const filtered = db.employees.filter(emp => {
        return (branchId === 'all' || emp.branchId === branchId)
            && (!nameFilter || normalizeText(emp.name).includes(nameFilter));
    });

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="${totalCols}">لا توجد بيانات للعرض مع الفلاتر الحالية</td></tr>`;
        refreshMainAndReportTablesUI();
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
    let totalAnnualAll = 0;
    let totalOtherLeaveAll = 0;
    let totalActualAll = 0;
    let totalExpectedAmountAll = 0;
    let totalActualAmountAll = 0;
    let totalAdvancesAll = 0;
    let totalNetAll = 0;
    const dateAbsenceCounts = workingDates.map(() => 0);
    const dateAnnualCounts = workingDates.map(() => 0);
    const dateOtherLeaveCounts = workingDates.map(() => 0);

    // الإجازات في النطاق
    const holidaysInRange = db.holidays.filter(h => h.date >= from && h.date <= to).map(h => h.date);

    filtered.forEach((emp, rowIdx) => {
        const rowNum = rowIdx + 1;
        const branchName = db.branches.find(b => b.id === emp.branchId)?.name || '';
        const expectedDays = workingDates.length;
        const dayWage = parseFloat(emp.wage) || 0;
        // تعديل جديد: إجمالي المبلغ المتوقع = الأيام المتوقعة × الأجر اليومي.
        // الكود الأصلي لم يكن يحتوي على هذا العمود أو هذا الحساب.
        const expectedAmount = expectedDays * dayWage;

        // حساب الغياب والإجازات من خلايا التاريخ (نفس مصدر getDailyStatusArray)
        let totalAbsenceDays = 0;
        let totalAnnualDays = 0;
        let totalOtherLeaveDays = 0;

        // أيام المناسبات
        let holidaysPresent = 0;
        holidaysInRange.forEach(hd => {
            const rec = db.absences.find(a => a.empId === emp.id && a.date === hd);
            if (!rec || (rec && rec.type !== 'absent' && rec.type !== 'annual')) holidaysPresent++;
        });

        // بناء خلايا التاريخ بالشكل: 0ح / 0.5غ / 0.5س / 0م
        let dateColsHtml = '';
        workingDates.forEach((d, idx) => {
            if (!d) { dateColsHtml += '<td></td>'; return; }
            const statusArr = getDailyStatusArray(emp, d);
            const N = statusArr.length || 1;
            let absentCount = 0, annualCount = 0, otherLeaveCount = 0, holidayCount = 0;
            statusArr.forEach(s => { if (s === 'absent') absentCount++; if (s === 'annual') annualCount++; if (s === 'other_leave') otherLeaveCount++; if (s === 'holiday_present') holidayCount++; });

            if (holidayCount === N) {
                dateColsHtml += `<td class="state-holiday">0م</td>`;
            } else {
                // حساب قيم الغياب والإجازات والإجازات الأخرى من الحالة الفعلية
                const absenceVal = absentCount / N;
                const annualVal = annualCount / N;
                const otherLeaveVal = otherLeaveCount / N;
                const totalVal = absenceVal + annualVal + otherLeaveVal;

                // تجميع الإجماليات لكل موظف (نفس مصدر خلايا التاريخ)
                totalAbsenceDays += absenceVal;
                totalAnnualDays += annualVal;
                totalOtherLeaveDays += otherLeaveVal;

                if (totalVal > 0) {
                    let displayParts = '';
                    let cellClass = '';
                    if (absenceVal > 0 && annualVal === 0 && otherLeaveVal === 0) {
                        cellClass = 'state-absent';
                    } else if ((annualVal > 0 || otherLeaveVal > 0) && absenceVal === 0) {
                        cellClass = 'state-annual';
                    } else if (absenceVal > 0) {
                        cellClass = 'state-absent';
                    }
                    if (absenceVal > 0) {
                        displayParts += Number.isInteger(absenceVal) ? `${absenceVal}غ` : `${absenceVal.toFixed(1)}غ`;
                    }
                    if (annualVal > 0) {
                        displayParts += (displayParts ? ' ' : '') + (Number.isInteger(annualVal) ? `${annualVal}س` : `${annualVal.toFixed(1)}س`);
                    }
                    if (otherLeaveVal > 0) {
                        displayParts += (displayParts ? ' ' : '') + (Number.isInteger(otherLeaveVal) ? `${otherLeaveVal}أ` : `${otherLeaveVal.toFixed(1)}أ`);
                    }
                    dateColsHtml += `<td class="${cellClass}">${displayParts}</td>`;
                    dateAbsenceCounts[idx] += absenceVal;
                    dateAnnualCounts[idx] += annualVal;
                    dateOtherLeaveCounts[idx] += otherLeaveVal;
                } else {
                    dateColsHtml += `<td class="state-present">0ح</td>`;
                }
            }
        });

        // الأيام الفعلية = المتوقعة - الغياب - الإجازات المستنفذه + المناسبات
        const actualDays = Math.max(0, expectedDays - totalAbsenceDays - totalAnnualDays - totalOtherLeaveDays + holidaysPresent);
        const extras = (db.dailyExtras || []).filter(x => x.empId === emp.id && x.date >= from && x.date <= to);
        const totalExtra = extras.reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0);
        // تعديل جديد: إجمالي المبلغ الفعلي = الأيام الفعلية × الأجر اليومي.
        // الكود الأصلي كان يحسب الصافي مباشرة من actualDays * dayWage + totalExtra.
        const actualAmount = actualDays * dayWage;
        const advances = (db.dailyAdvances || []).filter(x => x.empId === emp.id && x.date >= from && x.date <= to);
        const totalAdvance = advances.reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0);
        // الكود الأصلي معطل:
        // const salary = actualDays * dayWage + totalExtra;
        // تعديل جديد: السلف تخصم من إجمالي المبلغ الفعلي، والإضافي يضاف للصافي.
        const salary = actualAmount + totalExtra - totalAdvance;

        totalExpectedAll += expectedDays;
        totalExpectedAmountAll += expectedAmount;
        totalAbsenceAll += totalAbsenceDays;
        totalAnnualAll += totalAnnualDays;
        totalOtherLeaveAll += totalOtherLeaveDays;
        totalActualAll += actualDays;
        totalActualAmountAll += actualAmount;
        totalAdvancesAll += totalAdvance;
        totalNetAll += salary;

        tbody.innerHTML += `
            <tr>
                <td style="font-weight:bold;">${rowNum}</td>
                <td>${emp.employeeNumber || ''}</td>
                <td class="employee-name">${emp.name}</td>
                <td class="branch-name">${branchName}</td>
                <td dir="ltr" style="color:${emp.leaveBalance < 5 ? 'red' : 'green'}">${emp.leaveBalance}</td>
                <!-- تعديل جديد: تم نقل الأجر اليومي إلى هنا بعد رصيد الإجازات -->
                <td>${dayWage.toLocaleString()}</td>
                <td>${expectedDays}</td>
                <!-- تعديل جديد: عمود إجمالي المبلغ المتوقع -->
                <td style="font-weight:bold; background:#f7fbff;">${expectedAmount.toLocaleString()}</td>
                ${dateColsHtml}
                <td style="color:red; font-weight:bold;">${totalAbsenceDays}</td>
                <td style="color:#e67e22; font-weight:bold;">${totalAnnualDays}</td>
                <td style="color:#8e44ad; font-weight:bold;">${totalOtherLeaveDays}</td>
                <td style="color:green; font-weight:bold;">${actualDays}</td>
                <!-- تعديل جديد: عمود إجمالي المبلغ الفعلي بعد الأيام الفعلية -->
                <td style="font-weight:bold; background:#f1fff6;">${actualAmount.toLocaleString()}</td>
                <!-- تعديل جديد: عمود السلف، ويخصم من الصافي -->
                <td style="font-weight:bold; color:#c0392b;">${totalAdvance.toLocaleString()}</td>
                <!-- الكود الأصلي معطل: كان الأجر اليومي يظهر هنا بعد الأيام الفعلية -->
                <!-- <td>${dayWage.toLocaleString()}</td> -->
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
        const absVal = dateAbsenceCounts[idx] || 0;
        const annVal = dateAnnualCounts[idx] || 0;
        let display = '';
        if (absVal > 0) display += (Number.isInteger(absVal) ? absVal : absVal.toFixed(1)) + 'غ';
        if (annVal > 0) {
            display += (display ? ' ' : '') + (Number.isInteger(annVal) ? annVal : annVal.toFixed(1)) + 'س';
        }
        dynTotalsCells += `<td style="font-weight:bold;">${display}</td>`;
    });

    tbody.innerHTML += `
        <tr style="font-weight:bold; background:#f0f0f0;">
            <td></td>
            <td></td>
            <td>المجموع</td>
            <td></td>
            <td></td>
            <!-- تعديل جديد: ترك خانة الأجر اليومي فارغة في صف المجموع لأنه حقل فردي لكل موظف -->
            <td></td>
            <td>${totalExpectedAll}</td>
            <td style="background:#f7fbff;">${totalExpectedAmountAll.toLocaleString()}</td>
            ${dynTotalsCells}
            <td style="color:red;">${totalAbsenceAll}</td>
            <td style="color:#e67e22;">${totalAnnualAll}</td>
            <td style="color:#8e44ad;">${totalOtherLeaveAll}</td>
            <td style="color:green;">${totalActualAll}</td>
            <td style="background:#f1fff6;">${totalActualAmountAll.toLocaleString()}</td>
            <td style="color:#c0392b;">${totalAdvancesAll.toLocaleString()}</td>
            <!-- الكود الأصلي معطل: كانت هذه الخانة الفارغة لموضع الأجر اليومي القديم -->
            <!-- <td></td> -->
            <td>${db.dailyExtras.filter(x => x.date >= from && x.date <= to && filtered.some(emp => emp.id === x.empId)).reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0).toLocaleString()}</td>
            <td style="background:#e8f8f5;">${totalNetAll.toLocaleString()}</td>
            <td class="no-print"></td>
        </tr>`;
    refreshMainAndReportTablesUI();
}

function getDayName(dateStr, short = false) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const shortDays = ['أحد', 'إثن', 'ثلاث', 'أربع', 'خميس', 'جمعة', 'سبت'];
    return short ? shortDays[d.getDay()] : days[d.getDay()];
}

// دالة تعبئة السنة في قائمة السنوات
function populateReportYearSelect() {
    const yearSelect = document.getElementById('reportYear');
    if (!yearSelect) return;
    const currentYear = new Date().getFullYear();
    yearSelect.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear + 1; y++) {
        yearSelect.innerHTML += `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`;
    }
}

// دالة عند تغيير الشهر أو السنة - تحديث حقلي التاريخ
function reportMonthChanged() {
    const month = parseInt(document.getElementById('reportMonth').value);
    const year = parseInt(document.getElementById('reportYear').value);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);

    const fromStr = firstDay.toISOString().split('T')[0];
    const toStr = lastDay.toISOString().split('T')[0];

    document.getElementById('reportFrom').value = fromStr;
    document.getElementById('reportTo').value = toStr;

    renderReportTable();
}

// دالة عند تغيير حقلي التاريخ يدوياً - تحديث الشهر والسنة
function reportDateChanged() {
    const from = document.getElementById('reportFrom').value;
    if (from) {
        const d = new Date(from);
        const monthEl = document.getElementById('reportMonth');
        const yearEl = document.getElementById('reportYear');
        if (monthEl) monthEl.value = String(d.getMonth() + 1);
        if (yearEl) yearEl.value = String(d.getFullYear());
    }
    renderReportTable();
}

// دالة طباعة جدول التقرير مباشرة
function printReportTable() {
    const table = document.querySelector('#report-panel .table-wrapper table');
    if (!table) return alert('لا يوجد جدول للطباعة');

    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const monthIdx = parseInt(document.getElementById('reportMonth').value) - 1;
    const year = document.getElementById('reportYear').value;
    const monthName = monthNames[monthIdx] || '';
    const title = `تقرير الإجازات خلال شهر ${monthName} ${year}`;

    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    const tableClone = table.cloneNode(true);
    // إزالة أيقونات العين (👁️) من الطباعة
    tableClone.querySelectorAll('.col-toggle-btn').forEach(el => el.remove());
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

    const headerRowHtml = `<tr style="display:table-row;">
        <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
            ${logoHtml}
            <div style="font-size:16px;font-weight:bold;margin:3px 0;">${companyName}</div>
            <div style="font-size:14px;font-weight:bold;margin:2px 0;">${title}</div>
        </td>
    </tr>`;

    const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;
    const tableHtml = tableClone.outerHTML;
    const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

    // const printFooter = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const finalHtmlWithFooter = finalHtml.replace('</table>', printFooter + '</table>');

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
    </style>
</head>
<body>
    ${finalHtmlWithFooter}
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
}

// دالة معاينة طباعة جدول التقرير
function previewReportTable() {
    const table = document.querySelector('#report-panel .table-wrapper table');
    if (!table) { alert('لا يوجد جدول للطباعة'); return; }

    // حفظ عنوان التقرير في عنصر printTitle قبل فتح المعاينة
    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const monthIdx = parseInt(document.getElementById('reportMonth').value) - 1;
    const year = document.getElementById('reportYear').value;
    const monthName = monthNames[monthIdx] || '';
    const title = `تقرير الإجازات خلال شهر ${monthName} ${year}`;

    const printTitleEl = document.getElementById('printTitle');
    if (printTitleEl) printTitleEl.innerText = title;

    document.getElementById('printPreviewModal').style.display = 'block';
    // استخدام updatePrintPreview بعد تعديل العنوان
    updatePrintPreviewWithTitle(title);
}

// دالة مشابهة لـ updatePrintPreview ولكن مع عنوان مخصص
function updatePrintPreviewWithTitle(customTitle) {
    try {
        const paperSize = document.getElementById('previewPaperSize').value;
        const orientation = document.getElementById('previewOrientation').value;

        localStorage.setItem('tageep_paper_size', paperSize);
        localStorage.setItem('tageep_orientation', orientation);

        const table = document.querySelector('#report-panel .table-wrapper table');
        if (!table) return;

        const companyName = db.settings.companyName || '';
        const logoUrl = db.settings.logo || '';

        const tableClone = table.cloneNode(true);
        // إزالة أيقونات العين (👁️) من الطباعة
        tableClone.querySelectorAll('.col-toggle-btn').forEach(el => el.remove());
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
                <div style="font-size:14px;font-weight:bold;margin:2px 0;">${customTitle}</div>
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

        // const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
        //     <span class="signature">رئيس قسم الموارد البشرية</span>
        //     <span class="signature">رئيس قسم الحسابات</span>
        //     <span class="signature">المراجعة</span>
        //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        // </div></td></tr></tfoot>`;

        // const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');

        // const previewContent = `<!DOCTYPE html>
                // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>معاينة الطباعة - ${customTitle}</title>
    ${printStyles}
</head>
<body>
    ${finalHtmlWithFooter}
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
        iframeDoc.write(printContent);
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
        console.error('updatePrintPreviewWithTitle error:', err);
    }
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

    // ===== إنشاء أعمدة التاريخ الديناميكية في ترويسة جدول التقرير =====
    const headerRow = document.getElementById('reportTableHeaderRow');
    if (headerRow) {
        const existingDynamicCells = headerRow.querySelectorAll('.dyn-date-cell');
        existingDynamicCells.forEach(cell => cell.remove());

        // إدراج الأعمدة قبل عمود "أيام الحضور" (index 7 بسبب إضافة عمود "م")
        const insertBeforeCell = headerRow.children[7];
        workingDates.forEach((dateStr) => {
            const th = document.createElement('th');
            th.className = 'dyn-date-cell dyn-date';
            const parts = dateStr.split('-');
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1;
            const day = parseInt(parts[2], 10);
            const dateObj = new Date(year, month, day);
            const dayName = getDayName(dateStr, true);
            th.innerText = `${dateObj.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })} ${dayName}`;
            th.dataset.date = dateStr;
            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            th.title = 'انقر للفرز';

            const arrow = document.createElement('span');
            arrow.className = 'sort-arrow';
            arrow.style.cssText = 'margin-right:4px;font-size:11px;color:#888;';
            arrow.textContent = ' ⇅';
            th.appendChild(arrow);

            if (insertBeforeCell && headerRow) {
                headerRow.insertBefore(th, insertBeforeCell);
            }
        });
    }
    const dateRangeEl = document.getElementById('printDateRange');
    // تحديث عنوان التقرير باسم الشهر
    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const monthIdx = parseInt(document.getElementById('reportMonth')?.value || '1') - 1;
    const year = document.getElementById('reportYear')?.value || '';
    const monthName = monthNames[monthIdx] || '';
    const reportTitle = `تقرير الإجازات خلال شهر ${monthName} ${year}`;

    // تحديث عنوان التقرير في واجهة التقرير للطباعة
    const printTitleEl = document.getElementById('printTitle');
    if (printTitleEl) printTitleEl.innerText = reportTitle;

    if (dateRangeEl) {
        dateRangeEl.innerText = `${reportTitle} (من ${from || '? '} إلى ${to || '? '})`;
    }

    // ===== حساب المجاميع =====
    let totalExpectedAll = 0;
    let totalAbsenceAll = 0;
    let totalAnnualAll = 0;
    let totalOtherLeaveAll = 0;
    let totalActualAll = 0;
    let totalNetAll = 0;
    const dateAbsenceCounts = workingDates.map(() => 0);
    const dateAnnualCounts = workingDates.map(() => 0);
    const dateOtherLeaveCounts = workingDates.map(() => 0);

    filtered.forEach((emp, rowIdx) => {
        const rowNum = rowIdx + 1;
        const branchName = db.branches.find(b => b.id === emp.branchId)?.name || '';
        const shiftName = db.workShifts.find(s => s.id === emp.shiftId)?.name || '';
        const totals = getAbsenceTotalsForEmployee(emp, from, to);
        const absenceDays = totals.absenceDays;
        const annualUsed = totals.annualDays;
        const otherLeaveUsed = totals.otherLeaveDays;
        const holidayPresent = totals.holidayPresent;
        const leaveBalance = parseFloat(emp.leaveBalance) || 0;
        const remainingBalance = Math.max(0, leaveBalance);
        const expectedDays = workingDates.length;
        // أيام الحضور = المتوقعة - الغياب - الإجازات السنوية - الإجازة الأخرى + المناسبات (نفس التعقيب الرئيسي)
        const actualDays = Math.max(0, expectedDays - absenceDays - annualUsed - otherLeaveUsed + holidayPresent);
        const extras = (db.dailyExtras || []).filter(x => x.empId === emp.id && x.date >= from && x.date <= to);
        const totalExtra = extras.reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0);
        const dayWage = parseFloat(emp.wage) || 0;
        const salary = actualDays * dayWage + totalExtra;

        totalExpectedAll += expectedDays;
        totalAbsenceAll += absenceDays;
        totalAnnualAll += annualUsed;
        totalOtherLeaveAll += otherLeaveUsed;
        totalActualAll += actualDays;
        totalNetAll += salary;

        // تجميع مجاميع خلايا التاريخ
        workingDates.forEach((d, idx) => {
            if (!d) return;
            const statusArr = getDailyStatusArray(emp, d);
            const N = statusArr.length || 1;
            let absentCount = 0, annualCount = 0, otherLeaveCount = 0, holidayCount = 0;
            statusArr.forEach(s => { if (s === 'absent') absentCount++; if (s === 'annual') annualCount++; if (s === 'other_leave') otherLeaveCount++; if (s === 'holiday_present') holidayCount++; });
            const holidaysSet = new Set((db.holidays || []).filter(h => h.date >= from && h.date <= to).map(h => h.date));
            if (!(holidayCount === N && holidaysSet.has(d))) {
                dateAbsenceCounts[idx] += absentCount / N;
                dateAnnualCounts[idx] += annualCount / N;
                dateOtherLeaveCounts[idx] += otherLeaveCount / N;
            }
        });

        // عمود الفترة: يعرض اسم الفترة المحددة، أو أسماء فترات الدوام إذا كان الكل
        let periodText = '-';
        if (periodId && periodId !== 'all') {
            const shiftObj = db.workShifts.find(s => s.id === emp.shiftId);
            if (shiftObj) {
                const p = shiftObj.periods.find(pp => pp.id === periodId);
                periodText = p ? p.name : '-';
            }
        } else {
            // عرض أسماء الفترات بدلاً من اسم الدوام
            const shiftObj = db.workShifts.find(s => s.id === emp.shiftId);
            if (shiftObj && shiftObj.periods && shiftObj.periods.length) {
                periodText = shiftObj.periods.map(p => p.name).join(' / ');
            } else {
                periodText = '-';
            }
        }

        // بناء خلايا التاريخ لكل يوم عمل
        let dateColsHtml = '';
        workingDates.forEach((d) => {
            if (!d) { dateColsHtml += '<td></td>'; return; }
            const statusArr = getDailyStatusArray(emp, d);
            const N = statusArr.length || 1;
            let absentCount = 0, annualCount = 0, otherLeaveCount = 0, holidayCount = 0;
            statusArr.forEach(s => { if (s === 'absent') absentCount++; if (s === 'annual') annualCount++; if (s === 'other_leave') otherLeaveCount++; if (s === 'holiday_present') holidayCount++; });

            const holidaysSet = new Set((db.holidays || []).filter(h => h.date >= from && h.date <= to).map(h => h.date));
            if (holidayCount === N && holidaysSet.has(d)) {
                dateColsHtml += `<td class="state-holiday">0م</td>`;
            } else {
                const absenceVal = absentCount / N;
                const annualVal = annualCount / N;
                const otherLeaveVal = otherLeaveCount / N;
                const totalVal = absenceVal + annualVal + otherLeaveVal;
                if (totalVal > 0) {
                    let displayParts = '';
                    let cellClass = '';
                    if (absenceVal > 0 && annualVal === 0 && otherLeaveVal === 0) {
                        cellClass = 'state-absent';
                    } else if ((annualVal > 0 || otherLeaveVal > 0) && absenceVal === 0) {
                        cellClass = 'state-annual';
                    } else if (absenceVal > 0) {
                        cellClass = 'state-absent';
                    }
                    if (absenceVal > 0) {
                        displayParts += Number.isInteger(absenceVal) ? `${absenceVal}غ` : `${absenceVal.toFixed(1)}غ`;
                    }
                    if (annualVal > 0) {
                        displayParts += (displayParts ? ' ' : '') + (Number.isInteger(annualVal) ? `${annualVal}س` : `${annualVal.toFixed(1)}س`);
                    }
                    if (otherLeaveVal > 0) {
                        displayParts += (displayParts ? ' ' : '') + (Number.isInteger(otherLeaveVal) ? `${otherLeaveVal}أ` : `${otherLeaveVal.toFixed(1)}أ`);
                    }
                    dateColsHtml += `<td class="${cellClass}">${displayParts}</td>`;
                } else {
                    dateColsHtml += `<td class="state-present">0ح</td>`;
                }
            }
        });

        tbody.innerHTML += `
            <tr>
                <td style="font-weight:bold;">${rowNum}</td>
                <td>${emp.employeeNumber || ''}</td>
                <td class="employee-name">${emp.name}</td>
                <td class="branch-name">${branchName}</td>
                <td>${leaveBalance}</td>
                <td>${shiftName || '-'}</td>
                <td>${periodText}</td>
                ${dateColsHtml}
                <td>${actualDays}</td>
                <td>${absenceDays}</td>
                <td>${annualUsed}</td>
                <td>${otherLeaveUsed}</td>
                <td>${remainingBalance}</td>
                <td>${holidayPresent}</td>
                <td>${totalExtra.toLocaleString()}</td>
                <td>${salary.toLocaleString()}</td>
            </tr>`;
    });

    // ===== صف المجموع في جدول التقرير =====
    let dynTotalsCells = '';
    workingDates.forEach((d, idx) => {
        const absVal = dateAbsenceCounts[idx] || 0;
        const annVal = dateAnnualCounts[idx] || 0;
        let display = '';
        if (absVal > 0) display += (Number.isInteger(absVal) ? absVal : absVal.toFixed(1)) + 'غ';
        if (annVal > 0) {
            display += (display ? ' ' : '') + (Number.isInteger(annVal) ? annVal : annVal.toFixed(1)) + 'س';
        }
        dynTotalsCells += `<td style="font-weight:bold;">${display}</td>`;
    });

    tbody.innerHTML += `
        <tr style="font-weight:bold; background:#f0f0f0;">
            <td></td>
            <td></td>
            <td>المجموع</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            ${dynTotalsCells}
            <td style="color:green;">${totalActualAll}</td>
            <td style="color:red;">${totalAbsenceAll}</td>
            <td style="color:#e67e22;">${totalAnnualAll}</td>
            <td style="color:#8e44ad;">${totalOtherLeaveAll}</td>
            <td></td>
            <td></td>
            <td>${db.dailyExtras.filter(x => x.date >= from && x.date <= to && filtered.some(emp => emp.id === x.empId)).reduce((sum, x) => sum + (parseFloat(x.amount) || 0), 0).toLocaleString()}</td>
            <td style="background:#e8f8f5;">${totalNetAll.toLocaleString()}</td>
        </tr>`;
    refreshMainAndReportTablesUI();
}

// ===== جدول الإيضاحي: إحصاءات مقارنة بين الأسبوع الماضي والحالي =====
function renderSummaryTable() {
    const tbody = document.getElementById('summaryTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const branchId = document.getElementById('summaryBranch')?.value || 'all';
    const empId = document.getElementById('summaryEmp')?.value || 'all';
    let from = document.getElementById('summaryFrom')?.value || '';
    let to = document.getElementById('summaryTo')?.value || '';

    // إذا لم يتم تحديد تاريخ، نحدد نطاق افتراضي: من بداية الأسبوع الماضي إلى نهاية الأسبوع الحالي
    if (!from || !to) {
        const today = new Date();
        const currentDay = today.getDay(); // 0=Sunday
        // نهاية الأسبوع الحالي = السبت (إذا كانت الجمعة 5 هي العطلة)
        const daysToEndOfWeek = (currentDay <= 5) ? (5 - currentDay) : (5 + 7 - currentDay);
        const endOfCurrentWeek = new Date(today);
        endOfCurrentWeek.setDate(today.getDate() + daysToEndOfWeek);
        to = endOfCurrentWeek.toISOString().split('T')[0];

        // بداية الأسبوع الماضي = بداية الأسبوع الحالي - 14 يوم
        const startOfCurrentWeek = new Date(endOfCurrentWeek);
        startOfCurrentWeek.setDate(endOfCurrentWeek.getDate() - 6);
        // بداية الأسبوع الماضي = بداية الأسبوع الحالي - 7 أيام
        const startOfLastWeek = new Date(startOfCurrentWeek);
        startOfLastWeek.setDate(startOfCurrentWeek.getDate() - 7);
        from = startOfLastWeek.toISOString().split('T')[0];

        document.getElementById('summaryFrom').value = from;
        document.getElementById('summaryTo').value = to;
    }

    // عرض نطاق التاريخ
    const dateRangeEl = document.getElementById('summaryDateRange');
    if (dateRangeEl) {
        dateRangeEl.innerText = `نطاق التقرير: من ${from} إلى ${to}`;
    }

    // حساب طول الفترة بالأيام التقويمية
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const totalDays = Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24)) + 1;

    // نقسم الفترة إلى نصفين: الأسبوع الماضي والأسبوع الحالي
    const midDate = new Date(fromDate);
    midDate.setDate(fromDate.getDate() + Math.floor(totalDays / 2));
    const midStr = midDate.toISOString().split('T')[0];

    const lastWeekFrom = from;
    const lastWeekTo = midStr;
    const currentWeekFrom = new Date(midDate);
    currentWeekFrom.setDate(midDate.getDate() + 1);
    const currentWeekFromStr = currentWeekFrom.toISOString().split('T')[0];
    const currentWeekTo = to;

    // الموظفين المصفين
    const filteredEmps = db.employees.filter(emp => {
        if (branchId !== 'all' && emp.branchId !== branchId) return false;
        if (empId !== 'all' && emp.id !== empId) return false;
        return true;
    });

    // دوال مساعدة لحساب الإحصائيات
    function calcStats(frm, t) {
        const workingDates = getWorkingDatesBetween(frm, t);
        const expectedDays = workingDates.length;
        let totalActualDays = 0;
        let totalExpectedAll = 0;
        let totalEmployees = 0;
        let totalAmount = 0;
        const empCountSet = new Set();

        filteredEmps.forEach(emp => {
            const totals = getAbsenceTotalsForEmployee(emp, frm, t);
            const absenceDays = totals.absenceDays;
            const annualDays = totals.annualDays;
            const otherLeaveDays = totals.otherLeaveDays;
            const holidayPresent = totals.holidayPresent;
            const actualDays = Math.max(0, expectedDays - absenceDays - annualDays - otherLeaveDays + holidayPresent);
            const dayWage = parseFloat(emp.wage) || 0;
            const amount = actualDays * dayWage;

            totalExpectedAll += expectedDays;
            totalActualDays += actualDays;
            totalAmount += amount;
            if (actualDays > 0 || absenceDays > 0 || annualDays > 0) {
                totalEmployees++;
                empCountSet.add(emp.id);
            }
        });

        return {
            expectedDays: totalExpectedAll,
            actualDays: totalActualDays,
            employeeCount: empCountSet.size,
            amount: totalAmount
        };
    }

    const lastWeekStats = calcStats(lastWeekFrom, lastWeekTo);
    const currentWeekStats = calcStats(currentWeekFromStr, currentWeekTo);
    const actualStats = calcStats(from, to);

    // حساب المتوقع (كل الموظفين × أيام العمل)
    const workingDates = getWorkingDatesBetween(from, to);
    const expectedDaysAll = workingDates.length * filteredEmps.length;
    const lastWeekWorking = getWorkingDatesBetween(lastWeekFrom, lastWeekTo);
    const lastWeekExpected = lastWeekWorking.length * filteredEmps.length;
    const currentWeekWorking = getWorkingDatesBetween(currentWeekFromStr, currentWeekTo);
    const currentWeekExpected = currentWeekWorking.length * filteredEmps.length;

    // بناء الصفوف
    const rows = [
        {
            label: 'الأسبوع الماضي المتوقع',
            actualDays: '-',
            empCount: filteredEmps.length || '-',
            totalDays: lastWeekExpected || '-',
            amount: '-',
            dayDiff: '-',
            empDiff: '-',
            notes: 'المتوقع بناءً على أيام العمل'
        },
        {
            label: 'الأسبوع الحالي المتوقع',
            actualDays: '-',
            empCount: filteredEmps.length || '-',
            totalDays: currentWeekExpected || '-',
            amount: '-',
            dayDiff: '-',
            empDiff: '-',
            notes: 'المتوقع بناءً على أيام العمل'
        },
        {
            label: 'الأسبوع الماضي الفعلي',
            actualDays: lastWeekStats.actualDays || 0,
            empCount: lastWeekStats.employeeCount || 0,
            totalDays: lastWeekStats.expectedDays || 0,
            amount: lastWeekStats.amount || 0,
            dayDiff: lastWeekExpected > 0 ? (lastWeekStats.actualDays - lastWeekExpected) : '-',
            empDiff: filteredEmps.length > 0 ? (lastWeekStats.employeeCount - filteredEmps.length) : '-',
            notes: `من ${lastWeekFrom} إلى ${lastWeekTo}`
        },
        {
            label: 'الأسبوع الحالي الفعلي',
            actualDays: currentWeekStats.actualDays || 0,
            empCount: currentWeekStats.employeeCount || 0,
            totalDays: currentWeekStats.expectedDays || 0,
            amount: currentWeekStats.amount || 0,
            dayDiff: currentWeekExpected > 0 ? (currentWeekStats.actualDays - currentWeekExpected) : '-',
            empDiff: filteredEmps.length > 0 ? (currentWeekStats.employeeCount - filteredEmps.length) : '-',
            notes: `من ${currentWeekFromStr} إلى ${currentWeekTo}`
        }
    ];

    rows.forEach(row => {
        const formatNum = (val) => {
            if (val === '-' || val === undefined || val === null) return '-';
            if (typeof val === 'number') return val.toLocaleString('ar-EG', { maximumFractionDigits: 1 });
            return val;
        };
        const formatAmount = (val) => {
            if (val === '-' || val === undefined || val === null) return '-';
            if (typeof val === 'number') return val.toLocaleString('ar-EG', { maximumFractionDigits: 2 });
            return val;
        };
        const diffClass = (val) => {
            if (val === '-' || val === undefined || val === null) return '';
            if (typeof val === 'number') {
                return val < 0 ? 'style="color:red;font-weight:bold;"' : 'style="color:green;font-weight:bold;"';
            }
            return '';
        };

        tbody.innerHTML += `
            <tr>
                <td style="font-weight:bold;text-align:right;">${row.label}</td>
                <td contenteditable="true" style="cursor:text;">${formatNum(row.actualDays)}</td>
                <td contenteditable="true" style="cursor:text;">${formatNum(row.empCount)}</td>
                <td contenteditable="true" style="cursor:text;">${formatNum(row.totalDays)}</td>
                <td contenteditable="true" style="cursor:text;">${formatAmount(row.amount)}</td>
                <td ${diffClass(row.dayDiff)} contenteditable="true" style="cursor:text;">${formatNum(row.dayDiff)}</td>
                <td ${diffClass(row.empDiff)} contenteditable="true" style="cursor:text;">${formatNum(row.empDiff)}</td>
                <td contenteditable="true" style="font-size:12px;color:#666;cursor:text;">${row.notes}</td>
            </tr>`;
    });

    // تحديث نطاق التاريخ للطباعة
    const printDateRange = document.getElementById('printDateRange');
    if (printDateRange) {
        printDateRange.innerText = `جدول إيضاحي - من ${from} إلى ${to}`;
    }
}

// دالة طباعة جدول الإيضاحي
function printSummaryTable() {
    const table = document.querySelector('#summary-panel .table-wrapper table');
    if (!table) return alert('لا يوجد جدول للطباعة');

    const from = document.getElementById('summaryFrom')?.value || '';
    const to = document.getElementById('summaryTo')?.value || '';
    const title = `جدول إيضاحي - من ${from} إلى ${to}`;

    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    const tableClone = table.cloneNode(true);

    const firstRow = tableClone.querySelector('tr');
    const colCount = firstRow ? firstRow.cells.length : 1;

    const originalThead = tableClone.querySelector('thead');
    let columnHeadersHtml = '';
    if (originalThead) {
        columnHeadersHtml = originalThead.querySelector('tr').outerHTML;
    }

    const headerRowHtml = `<tr style="display:table-row;">
        <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
            ${logoHtml}
            <div style="font-size:16px;font-weight:bold;margin:3px 0;">${companyName}</div>
            <div style="font-size:14px;font-weight:bold;margin:2px 0;">${title}</div>
        </td>
    </tr>`;

    const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;
    const tableHtml = tableClone.outerHTML;
    const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

    // const printFooter = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const finalHtmlWithFooter = finalHtml.replace('</table>', printFooter + '</table>');

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
    </style>
</head>
<body>
    ${finalHtmlWithFooter}
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
}

// دالة معاينة طباعة جدول الإيضاحي
function previewSummaryTable() {
    const table = document.querySelector('#summary-panel .table-wrapper table');
    if (!table) { alert('لا يوجد جدول للطباعة'); return; }

    const from = document.getElementById('summaryFrom')?.value || '';
    const to = document.getElementById('summaryTo')?.value || '';
    const title = `جدول إيضاحي - من ${from} إلى ${to}`;

    const printTitleEl = document.getElementById('printTitle');
    if (printTitleEl) printTitleEl.innerText = title;

    document.getElementById('printPreviewModal').style.display = 'block';
    // استخدام updatePrintPreview بعد تعديل العنوان
    updatePrintPreviewWithTitle(title);
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
    const nameFilter = normalizeText(document.getElementById('empFilterName')?.value || '');
    const filteredEmployees = db.employees.filter(e => {
        if (branchFilter !== 'all' && e.branchId !== branchFilter) return false;
        if (nameFilter && !normalizeText(e.name).includes(nameFilter)) return false;
        return true;
    });
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

function printEmployeesTable() {
    if (!canPerform('employees', 'view')) return alert('ليس لديك صلاحية لعرض الموظفين');

    const empTable = document.querySelector('#tab-employees .table-wrapper table');
    if (!empTable) return alert('لا يوجد جدول للطباعة');

    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    const tableClone = empTable.cloneNode(true);
    // إزالة عمود الإجراءات
    const rows = tableClone.querySelectorAll('tr');
    rows.forEach(row => {
        const lastCell = row.querySelector('td:last-child, th:last-child');
        if (lastCell) lastCell.remove();
    });

    const firstRow = tableClone.querySelector('tr');
    const colCount = firstRow ? firstRow.cells.length : 1;

    const originalThead = tableClone.querySelector('thead');
    let columnHeadersHtml = '';
    if (originalThead) {
        columnHeadersHtml = originalThead.querySelector('tr').outerHTML;
    }

    const headerRowHtml = `<tr style="display:table-row;">
        <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
            ${logoHtml}
            <div style="font-size:16px;font-weight:bold;margin:3px 0;">${companyName}</div>
            <div style="font-size:14px;font-weight:bold;margin:2px 0;">كشف بيانات الموظفين</div>
        </td>
    </tr>`;

    const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;
    const tableHtml = tableClone.outerHTML;
    const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

    // const printFooter = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const finalHtmlWithFooter = finalHtml.replace('</table>', printFooter + '</table>');

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>طباعة كشف الموظفين</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
    </style>
</head>
<body>
    ${finalHtmlWithFooter}
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
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

async function saveShiftPeriod() {
    if (!canPerform('settings', 'edit') && !canPerform('settings', 'add')) return alert('ليس لديك صلاحية لحفظ الفترة');
    const shiftId = document.getElementById('selectedShiftId').value;
    const shift = db.workShifts.find(s => s.id === shiftId);
    if (!shift) return alert('اختر دواماً أولاً أو قم بإنشاء دوام جديد');
    const id = document.getElementById('periodEditId').value;
    const name = document.getElementById('periodName').value.trim();
    const start = document.getElementById('periodStart').value;
    const end = document.getElementById('periodEnd').value;
    if (!name || !start || !end) return alert('أكمل بيانات الفترة');
    if (id) {
        const period = shift.periods.find(p => p.id === id);
        if (period) {
            period.name = name;
            period.startTime = start;
            period.endTime = end;
        }
    } else {
        const newId = 'p' + Date.now();
        shift.periods.push({ id: newId, name, startTime: start, endTime: end });
        console.log('saveShiftPeriod: shiftId=', shiftId, 'newPeriodId=', newId);
    }
    resetPeriodForm();
    saveDB();
    try {
        await persistRemoteState();
        if (backendAvailable) alert('تم حفظ الفترة في قاعدة البيانات');
        else alert('تم حفظ الفترة محلياً فقط؛ تحقق من اتصال الباكند.');
    } catch (e) {
        console.warn('saveShiftPeriod: persistRemoteState error', e);
    }
    renderShiftPeriods();
    renderWorkShifts();
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
    const canEdit = canPerform('daily', 'edit');
    const canDelete = canPerform('daily', 'delete');

    const filtered = db.dailyFollowUps.filter(item => {
        return (branchId === 'all' || item.branchId === branchId)
            && (empId === 'all' || item.empId === empId)
            && (statusFilter === 'all' || item.statusType === statusFilter)
            && (!from || item.date >= from)
            && (!to || item.date <= to);
    });

    filtered.forEach((item, rowIdx) => {
        const rowNum = rowIdx + 1;
        const employee = db.employees.find(e => e.id === item.empId) || { name: '' };
        const branchName = db.branches.find(b => b.id === item.branchId)?.name || '';
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }

        tbody.innerHTML += `
            <tr>
                <td style="font-weight:bold;">${rowNum}</td>
                <td>${getDayName(item.date)} - ${item.date}</td>
                <td>${employee.employeeNumber || ''}</td>
                <td class="employee-name">${employee.name}</td>
                <td class="branch-name">${branchName}</td>
                <td>${statusLabel}</td>
                <td>${periodLabel}</td>
                <td>${item.notes || '-'}</td>
                <td class="no-print">
                    ${canEdit ? `<button onclick="editDailyEntry('${item.id}')" class="btn-warning">تعديل</button>` : ''}
                    ${canDelete ? `<button onclick="deleteDailyEntry('${item.id}')" class="btn-danger">حذف</button>` : ''}
                </td>
            </tr>
        `;
    });
}

function editDailyEntry(id) {
    if (!canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل سجلات التعقيب اليومي');
    const entry = db.dailyFollowUps.find(x => x.id === id);
    if (!entry) return alert('السجل غير موجود');

    document.getElementById('dailyEditId').value = entry.id;
    document.getElementById('dailyBranch').value = entry.branchId;
    document.getElementById('dailyEmp').value = entry.empId;
    document.getElementById('dailyDate').value = entry.date;
    document.getElementById('dailyStatus').value = entry.statusType;
    const notesEl = document.getElementById('dailyNotes');
    if (notesEl) notesEl.value = entry.notes || '';

    // تعبئة حقل الفترة (القيمة)
    const periodVal = entry.period || entry.value || 'all';
    // محاولة تعبئة حقل dailyPeriod إن وجد
    const periodEl = document.getElementById('dailyPeriod');
    if (periodEl) {
        periodEl.value = periodVal;
    } else {
        // إذا لم يوجد dailyPeriod بعد، نعبي dailyValue
        const valueEl = document.getElementById('dailyValue');
        if (valueEl) valueEl.value = periodVal;
    }

    // تغيير نص زر الحفظ
    const btnSave = document.getElementById('btnSaveDaily');
    if (btnSave) btnSave.innerText = 'تحديث التعقيب اليومي';

    // التبديل إلى لوحة التعقيب اليومي لإظهار البيانات
    switchDailyPanel('daily-followup-panel');
}


function saveDailyEntry() {
    if (!canPerform('daily', 'add') && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لحفظ سجلات التعقيب اليومي');
    const id = document.getElementById('dailyEditId').value;
    const empId = document.getElementById('dailyEmp').value;
    const branchId = document.getElementById('dailyBranch').value;
    const date = document.getElementById('dailyDate').value;
    let statusType = document.getElementById('dailyStatus').value;
    const periodEl = document.getElementById('dailyPeriod');
    const period = periodEl ? periodEl.value : 'all';
    const notes = document.getElementById('dailyNotes').value.trim();
    if (!empId || !branchId || !date) return alert('أكمل بيانات التعقيب اليومي');
    if (statusType === 'other_leave' && !notes) return alert('يرجى كتابة ملاحظات نوع الإجازة الأخرى مثل: مرضية أو وفاة أو زواج');
    if (id && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل سجل التعقيب اليومي');
    if (!id && !canPerform('daily', 'add')) return alert('ليس لديك صلاحية لإضافة سجل التعقيب اليومي');
    const duplicateDaily = db.dailyFollowUps.find(x => x.empId === empId && x.date === date && x.period === period && x.id !== id);
    if (duplicateDaily) return alert('يوجد تعقيب لنفس الموظف، نفس التاريخ ونفس الفترة مسبقاً');

    const emp = findEmployeeById(empId);
    const oldEntry = id ? db.dailyFollowUps.find(x => x.id === id) : null;
    const oldValue = oldEntry && oldEntry.statusType === 'annual' ? getLeaveDeductionValue(oldEntry.statusType, oldEntry.period) : 0;
    const newValue = getLeaveDeductionValue(statusType, period);

    if (oldEntry && oldEntry.statusType === 'annual' && emp) {
        emp.leaveBalance = parseFloat(emp.leaveBalance || 0) + oldValue;
    }
    if (statusType === 'annual' && emp) {
        emp.leaveBalance = Math.max(0, parseFloat(emp.leaveBalance || 0) - newValue);
    }

    let entry = { id: id || 'd' + Date.now(), empId, branchId, date, statusType, period, notes, value: newValue, createdAt: new Date().toISOString() };
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
    // إعادة نص زر الحفظ إلى النص الأصلي
    const btnSave = document.getElementById('btnSaveDaily');
    if (btnSave) btnSave.innerText = 'حفظ التعقيب اليومي';
}

function deleteDailyEntry(id) {
    if (!canPerform('daily', 'delete')) return alert('ليس لديك صلاحية لحذف سجلات التعقيب اليومي');
    if (!confirm('هل تريد حذف هذا السجل؟')) return;
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
                <td class="employee-name">${employee.name}</td>
                <td class="branch-name">${branchName}</td>
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

// ========== Daily Advances ==========
// تعديل جديد: قسم السلف مبني بنفس فكرة قسم الإضافي.
// الكود الأصلي معطل: لم يكن يحتوي على render/save/edit/delete للسلف.
function renderDailyAdvances() {
    const tbody = document.getElementById('advanceTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const branchId = document.getElementById('dailyFilterBranch')?.value || 'all';
    const empId = document.getElementById('advanceFilterEmp')?.value || 'all';
    const from = document.getElementById('advanceFilterFrom')?.value || '';
    const to = document.getElementById('advanceFilterTo')?.value || '';
    const canEdit = canPerform('daily', 'edit');
    const canDelete = canPerform('daily', 'delete');

    const filtered = (db.dailyAdvances || []).filter(item => {
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
                <td class="employee-name">${employee.name}</td>
                <td class="branch-name">${branchName}</td>
                <td>${(parseFloat(item.amount) || 0).toLocaleString()}</td>
                <td>${item.notes || '-'}</td>
                <td class="no-print">
                    ${canEdit ? `<button onclick="editDailyAdvance('${item.id}')" class="btn-warning">تعديل</button>` : ''}
                    ${canDelete ? `<button onclick="deleteDailyAdvance('${item.id}')" class="btn-danger">حذف</button>` : ''}
                </td>
            </tr>
        `;
    });
}

async function saveDailyAdvance() {
    if (!canPerform('daily', 'add') && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لحفظ السلف');
    const id = document.getElementById('advanceEditId').value;
    const empId = document.getElementById('advanceEmp').value;
    const date = document.getElementById('advanceDate').value;
    const amount = parseFloat(document.getElementById('advanceAmount').value) || 0;
    const notes = document.getElementById('advanceNotes').value.trim();
    if (!empId || !date || amount <= 0) return alert('أكمل بيانات السلفة بمبلغ صحيح');
    if (id && !canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل السلفة');
    if (!id && !canPerform('daily', 'add')) return alert('ليس لديك صلاحية لإضافة السلفة');
    const duplicateAdvance = (db.dailyAdvances || []).find(x => x.empId === empId && x.date === date && x.id !== id);
    if (duplicateAdvance) return alert(`يوجد سلفة مسجلة مسبقاً للموظف ${getEmployeeLabel(empId)} في تاريخ ${date}`);

    const entry = { id: id || 'adv' + Date.now(), empId, date, amount, notes, createdAt: new Date().toISOString() };
    if (id) {
        const idx = db.dailyAdvances.findIndex(x => x.id === id);
        if (idx !== -1) db.dailyAdvances[idx] = entry;
    } else {
        db.dailyAdvances = db.dailyAdvances || [];
        db.dailyAdvances.push(entry);
    }
    const saveButton = document.getElementById('btnSaveAdvance');
    const originalText = saveButton ? saveButton.innerText : '';
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.innerText = 'جاري الحفظ...';
    }
    await saveDB({ waitRemote: true });
    if (saveButton) {
        saveButton.disabled = false;
        saveButton.innerText = originalText || (id ? 'تحديث السلفة' : 'إضافة السلفة');
    }
    resetDailyAdvanceForm();
}

function editDailyAdvance(id) {
    if (!canPerform('daily', 'edit')) return alert('ليس لديك صلاحية لتعديل السلفة');
    const entry = (db.dailyAdvances || []).find(x => x.id === id);
    if (!entry) return alert('سجل السلفة غير موجود');
    document.getElementById('advanceEditId').value = entry.id;
    document.getElementById('advanceEmp').value = entry.empId;
    document.getElementById('advanceDate').value = entry.date;
    document.getElementById('advanceAmount').value = entry.amount;
    document.getElementById('advanceNotes').value = entry.notes || '';
    document.getElementById('btnSaveAdvance').innerText = 'تحديث السلفة';
    switchDailyPanel('daily-advance-panel');
}

function resetDailyAdvanceForm() {
    document.getElementById('advanceEditId').value = '';
    document.getElementById('advanceEmp').value = '';
    document.getElementById('advanceDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('advanceAmount').value = '';
    document.getElementById('advanceNotes').value = '';
    document.getElementById('btnSaveAdvance').innerText = 'إضافة السلفة';
}

async function deleteDailyAdvance(id) {
    if (!canPerform('daily', 'delete')) return alert('ليس لديك صلاحية لحذف السلفة');
    if (!confirm('هل تريد حذف هذه السلفة؟')) return;
    db.dailyAdvances = (db.dailyAdvances || []).filter(x => x.id !== id);
    await saveDB({ waitRemote: true });
}

function switchDailyPanel(panelId) {
    document.querySelectorAll('.daily-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.sub-tab-btn[data-daily-panel]').forEach(btn => btn.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.sub-tab-btn[data-daily-panel="${panelId}"]`);
    if (btn) btn.classList.add('active');
    // تعديل جديد: إعادة رسم السلف عند فتح تبويبها، مثل الإضافي.
    // الكود الأصلي كان يبدّل اللوحة فقط دون منطق خاص بالسلف.
    if (panelId === 'daily-advance-panel') {
        renderDailyAdvances();
    } else if (panelId === 'daily-extra-panel') {
        renderDailyExtras();
    }
}

// ========== Archive Panel Switching ==========
function switchArchivePanel(panelId) {
    document.querySelectorAll('.archive-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.sub-tab-btn[data-archive-panel]').forEach(btn => btn.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.sub-tab-btn[data-archive-panel="${panelId}"]`);
    if (btn) btn.classList.add('active');
    if (panelId === 'archive-archived-panel') {
        renderArchiveReports();
    } else if (panelId === 'archive-sent-panel') {
        renderSentReports();
    }
}

// ========== Send Daily Records (المرحلة الأولى: إرسال التعقيب اليومي) ==========
function sendDailyRecords() {
    if (!canPerform('daily', 'view')) return alert('ليس لديك صلاحية لإرسال التعقيب');
    const branchId = document.getElementById('dailyFilterBranch').value;
    const dateFrom = document.getElementById('dailyFilterFrom').value;
    const dateTo = document.getElementById('dailyFilterTo').value;
    const branchName = branchId === 'all' ? 'الكل' : db.branches.find(b => b.id === branchId)?.name || 'الكل';

    const records = db.dailyFollowUps.filter(item => {
        return (branchId === 'all' || item.branchId === branchId)
            && (!dateFrom || item.date >= dateFrom)
            && (!dateTo || item.date <= dateTo);
    });

    if (!records.length) return alert('لا توجد سجلات لإرسالها. اختر فرعاً وفترة صحيحة.');
    if (!confirm(`هل تريد إرسال ${records.length} سجل تعقيب يومي للفرع "${branchName}" إلى مدير الموارد البشرية؟`)) return;

    const reportId = 'sr' + Date.now();
    db.sentReports.push({
        id: reportId,
        branchId: branchId,
        branchName: branchName,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        entries: JSON.parse(JSON.stringify(records)),
        status: 'pending'
    });

    // حذف السجلات من التعقيب اليومي بعد الإرسال
    const recordIds = new Set(records.map(r => r.id));
    db.dailyFollowUps = db.dailyFollowUps.filter(item => !recordIds.has(item.id));

    saveDB();
    renderDailyFollowups();
    renderSentReports();
    alert(`تم إرسال ${records.length} سجل تعقيب إلى مدير الموارد البشرية بنجاح. يمكنك متابعة الحالة في "أرشفة التعقيب المرحل ← التعقيب المرسل".`);
}

// ========== Render Sent Reports (المرحلة الثانية: عرض التعقيب المرسل) ==========
function renderSentReports() {
    // عرض جدول التقارير المرسلة (قائمة بالتقارير)
    const sentListTbody = document.getElementById('sentTableBody');
    if (!sentListTbody) return;
    sentListTbody.innerHTML = '';

    const branchId = document.getElementById('sentFilterBranch')?.value || 'all';
    const from = document.getElementById('sentFilterFrom')?.value || '';
    const to = document.getElementById('sentFilterTo')?.value || '';
    const canTransfer = currentUser && currentUser.role === 'admin';

    // تحديث قائمة الفروع حسب المستخدم
    const branchSelect = document.getElementById('sentFilterBranch');
    if (branchSelect) {
        const isBranchUser = currentUser && currentUser.role !== 'admin';
        const userBranchId = isBranchUser ? currentUser.branchId : null;
        const userBranches = isBranchUser && userBranchId ? db.branches.filter(b => b.id === userBranchId) : db.branches;
        const savedVal = branchSelect.value;
        branchSelect.innerHTML = '<option value="all">الكل</option>';
        userBranches.forEach(b => {
            branchSelect.innerHTML += `<option value="${b.id}">${b.name}</option>`;
        });
        branchSelect.value = userBranches.find(b => b.id === savedVal) ? savedVal : 'all';
    }

    const filtered = db.sentReports.filter(report => {
        return (branchId === 'all' || report.branchId === branchId)
            && (!from || report.date >= from)
            && (!to || report.date <= to);
    });

    if (!filtered.length) {
        sentListTbody.innerHTML = '<tr><td colspan="6">لا توجد تقارير مرسلة</td></tr>';
        return;
    }

    filtered.forEach(report => {
        const statusLabel = report.status === 'pending' ? 'بانتظار الترحيل' : 'تم الترحيل';
        const statusColor = report.status === 'pending' ? '#f39c12' : '#27ae60';
        const canTransferThis = canTransfer && report.status === 'pending';

        sentListTbody.innerHTML += `
            <tr>
                <td>${report.branchName}</td>
                <td>${report.date}</td>
                <td>${report.entries.length}</td>
                <td>${new Date(report.createdAt).toLocaleString('ar-EG')}</td>
                <td style="color:${statusColor}; font-weight:bold;">${statusLabel}</td>
                <td class="no-print">
                    ${canTransferThis ? `<button onclick="transferSentReportToMain('${report.id}')" class="btn-warning" style="background-color:#e67e22;">🔁 ترحيل إلى التعقيب الرئيسي</button>` : ''}
                    ${canPerform('archive', 'edit') ? `<button onclick="editSentReport('${report.id}')" class="btn-warning" style="margin-right:4px;">✏️ تعديل</button>` : ''}
                    <button onclick="previewSentReport('${report.id}')" style="margin-right:4px;">🖨️ معاينة الطباعة</button>
                </td>
            </tr>
        `;
    });
}

// === دالة تعديل التعقيب المرسل (تعمل نفس طريقة تعديل الأرشيف) ===
function editSentReport(reportId) {
    if (!canPerform('archive', 'edit')) return alert('ليس لديك صلاحية لتعديل التعقيب المرسل');
    const report = db.sentReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // إنشاء نافذة التعديل المنبثقة (نفس تصميم editArchivedReport)
    let html = `<div style="direction:rtl; padding:20px; font-family:Tahoma,sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #2c3e50; padding-bottom:10px; margin-bottom:15px;">
            <h3 style="margin:0;">✏️ تعديل التعقيب المرسل - ${report.branchName}</h3>
            <span onclick="closeEditArchivedModal()" style="font-size:28px; font-weight:bold; color:#e74c3c; cursor:pointer; padding:0 10px;">&times;</span>
        </div>
        <p style="text-align:center;">تاريخ الإرسال: ${report.date} | الحالة: ${report.status === 'pending' ? 'بانتظار الترحيل' : 'تم الترحيل'} | إجمالي السجلات: ${(report.entries || []).length}</p>
        <p style="text-align:center; color:#666; font-size:13px;">قم بتعديل البيانات ثم اضغط "حفظ التعديلات" لتحديث التعقيب الرئيسي والمرسل تلقائياً.</p>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <thead>
                <tr style="background:#2c3e50; color:white;">
                    <th style="padding:6px; border:1px solid #333;">م</th>
                    <th style="padding:6px; border:1px solid #333;">التاريخ</th>
                    <th style="padding:6px; border:1px solid #333;">رقم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">اسم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">الحالة</th>
                    <th style="padding:6px; border:1px solid #333;">الفترة</th>
                    <th style="padding:6px; border:1px solid #333;">ملاحظات</th>
                </tr>
            </thead>
            <tbody>`;

    const entries = report.entries || [];
    entries.forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusOptions = ['present', 'absent', 'annual', 'other_leave', 'holiday_present']
            .map(s => `<option value="${s}" ${item.statusType === s ? 'selected' : ''}>${s === 'present' ? 'حاضر' : s === 'absent' ? 'غائب' : s === 'annual' ? 'إجازة سنوية' : s === 'other_leave' ? 'إجازة أخرى' : 'مناسبة'
                }</option>`).join('');

        let periodOptions = '<option value="all">الكل</option>';
        const emp = employee.id ? db.employees.find(e => e.id === item.empId) : null;
        const shift = emp ? db.workShifts.find(s => s.id === emp.shiftId) : null;
        if (shift && shift.periods && shift.periods.length) {
            shift.periods.forEach(p => {
                periodOptions += `<option value="${p.id}" ${item.period === p.id ? 'selected' : ''}>${p.name}</option>`;
            });
        }

        html += `<tr${idx % 2 === 0 ? ' style="background:#f2f2f2;"' : ''}>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${idx + 1}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <input type="date" id="editDate_${idx}" value="${item.date}" style="width:130px; padding:3px; border:1px solid #ccc; border-radius:3px;">
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.employeeNumber || ''}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.name}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <select id="editStatus_${idx}" style="padding:4px; border:1px solid #ccc; border-radius:3px;">
                    ${statusOptions}
                </select>
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <select id="editPeriod_${idx}" style="padding:4px; border:1px solid #ccc; border-radius:3px;">
                    ${periodOptions}
                </select>
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <input type="text" id="editNotes_${idx}" value="${item.notes || ''}" style="width:90%; padding:4px; border:1px solid #ccc; border-radius:3px;" placeholder="ملاحظات...">
            </td>
        </tr>`;
    });

    html += `</tbody></table>
        <div style="text-align:center; margin-top:20px;">
            <button onclick="saveSentReportEdits('${reportId}')" style="padding:10px 30px; background-color:#27ae60; color:white; border:none; border-radius:4px; cursor:pointer; font-size:14px; font-weight:bold;">💾 حفظ التعديلات</button>
            <button onclick="closeEditArchivedModal()" style="padding:10px 20px; background-color:#e74c3c; color:white; border:none; border-radius:4px; cursor:pointer; margin-right:10px;">إلغاء</button>
        </div>
    </div>`;

    const modalDiv = document.createElement('div');
    modalDiv.id = 'editArchivedModal';
    modalDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
    modalDiv.innerHTML = `
        <div style="background:#fff;width:90%;max-width:1200px;max-height:90vh;overflow:auto;padding:20px;border-radius:8px;direction:rtl;">
            ${html}
        </div>`;
    document.body.appendChild(modalDiv);
}

// دالة حفظ تعديلات التعقيب المرسل
function saveSentReportEdits(reportId) {
    if (!canPerform('archive', 'edit')) return alert('ليس لديك صلاحية لتعديل التعقيب المرسل');
    const report = db.sentReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // جمع التعديلات من النموذج
    const entries = report.entries || [];
    const changes = [];

    entries.forEach((item, idx) => {
        const statusSelect = document.getElementById(`editStatus_${idx}`);
        const periodSelect = document.getElementById(`editPeriod_${idx}`);
        const notesInput = document.getElementById(`editNotes_${idx}`);
        const dateInput = document.getElementById(`editDate_${idx}`);
        if (!statusSelect) return;

        const newStatus = statusSelect.value;
        const newPeriod = periodSelect ? periodSelect.value : (item.period || 'all');
        const newNotes = notesInput ? notesInput.value.trim() : '';
        const newDate = dateInput ? dateInput.value : item.date;

        if (newStatus !== item.statusType || newNotes !== (item.notes || '') || newDate !== item.date || newPeriod !== (item.period || 'all')) {
            changes.push({
                empId: item.empId,
                oldDate: item.date,
                newDate: newDate,
                oldStatus: item.statusType,
                newStatus: newStatus,
                oldPeriod: item.period || 'all',
                newPeriod: newPeriod,
                oldNotes: item.notes || '',
                newNotes: newNotes
            });

            item.statusType = newStatus;
            item.notes = newNotes;
            item.date = newDate;
            item.period = newPeriod;
        }
    });

    if (!changes.length) {
        alert('لم يتم إجراء أي تغييرات.');
        closeEditArchivedModal();
        return;
    }

    // تحديث التعقيب الرئيسي (absences) - نفس منطق saveArchivedReportEdits
    changes.forEach(change => {
        const mainRec = db.absences.find(a => a.empId === change.empId && a.date === change.oldDate);
        if (mainRec) {
            if (mainRec.type === 'annual') {
                const empObj = findEmployeeById(change.empId);
                if (empObj) empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) + parseFloat(mainRec.value || 1);
            }
            db.absences = db.absences.filter(a => !(a.id === mainRec.id));
        }
        if (change.newStatus !== 'present') {
            if (change.newStatus === 'annual') {
                const empObj = findEmployeeById(change.empId);
                if (empObj) empObj.leaveBalance = Math.max(0, parseFloat(empObj.leaveBalance || 0) - 1);
            }
            const rec = {
                id: 'a' + Date.now() + Math.random().toString(36).slice(2),
                empId: change.empId,
                date: change.newDate,
                value: 1,
                type: change.newStatus
            };
            addOrReplaceAbsenceRecord(rec);
        }
    });

    // تحديث الأرشيف (archivedReports) إذا كان التقرير قد تم ترحيله
    if (report.status === 'transferred') {
        db.archivedReports.forEach(archived => {
            archived.entries.forEach(entry => {
                const change = changes.find(c => c.empId === entry.empId && c.oldDate === entry.date);
                if (change) {
                    entry.statusType = change.newStatus;
                    entry.notes = change.newNotes;
                    entry.date = change.newDate;
                    entry.period = change.newPeriod;
                }
            });
        });
    }

    saveDB();
    closeEditArchivedModal();

    let summaryMsg = '✅ تم حفظ التعديلات بنجاح!\n\n';
    changes.forEach((c, i) => {
        const emp = findEmployeeById(c.empId);
        const empName = emp ? emp.name : c.empId;
        const statusLabels = { present: 'حاضر', absent: 'غائب', annual: 'إجازة سنوية', other_leave: 'إجازة أخرى', holiday_present: 'مناسبة' };
        const dateChanged = c.oldDate !== c.newDate ? ` (${c.oldDate} → ${c.newDate})` : ` (${c.oldDate})`;
        summaryMsg += i + 1 + '. ' + empName + dateChanged + ': ' + (statusLabels[c.oldStatus] || c.oldStatus) + ' → ' + (statusLabels[c.newStatus] || c.newStatus) + '\n';
    });
    summaryMsg += '\n📌 تم تحديث:\n- التعقيب المرسل ✅\n- التعقيب الرئيسي ✅' + (report.status === 'transferred' ? '\n- التعقيب المؤرشف ✅' : '');

    alert(summaryMsg);
    renderSentReports();
    renderMainTable();
    renderArchiveReports();
}

// ========== Transfer Sent Report to Main (المرحلة الثالثة: ترحيل التعقيب المرسل إلى الرئيسي) ==========
function transferSentReportToMain(reportId) {
    if (!currentUser || currentUser.role !== 'admin') return alert('فقط مدير الموارد البشرية يمكنه ترحيل التعقيب إلى الرئيسي');

    const report = db.sentReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');
    if (report.status !== 'pending') return alert('تم ترحيل هذا التقرير مسبقاً');

    // التحقق من عدم وجود تعارضات
    const duplicateEntry = report.entries.find(item =>
        item.statusType !== 'present' && db.absences.some(a => a.empId === item.empId && a.date === item.date)
    );
    if (duplicateEntry) {
        return alert(`لا يمكن الترحيل؛ يوجد سجل مسبقاً في التعقيب الرئيسي للموظف ${getEmployeeLabel(duplicateEntry.empId)} في تاريخ ${duplicateEntry.date}.`);
    }

    if (!confirm(`هل تريد ترحيل ${report.entries.length} سجل من تقرير "${report.branchName}" إلى التعقيب الرئيسي؟`)) return;

    // ترحيل السجلات إلى التعقيب الرئيسي
    report.entries.forEach(item => {
        if (item.statusType === 'present') return;
        const empObj = findEmployeeById(item.empId);
        const value = (item.period === 'all' || !item.period) ? 1 : 0.5;
        const rec = {
            id: 'a' + Date.now() + Math.random().toString(36).slice(2),
            empId: item.empId,
            date: item.date,
            value: value,
            type: item.statusType
        };
        addOrReplaceAbsenceRecord(rec);
    });

    // تحديث حالة التقرير
    report.status = 'transferred';

    // إنشاء ملف PDF للأرشفة
    const fileName = `sent_archive_${report.branchName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
    db.archivedReports.push({
        id: 'r' + Date.now(),
        branchId: report.branchId,
        branchName: report.branchName,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        entries: JSON.parse(JSON.stringify(report.entries)),
        fileName: fileName
    });

    saveDB();
    renderSentReports();
    renderMainTable();
    alert(`تم ترحيل ${report.entries.length} سجل من "${report.branchName}" إلى التعقيب الرئيسي بنجاح.`);
}

// ========== Preview Sent Report (معاينة طباعة التعقيب المرسل) ==========
function previewSentReport(reportId) {
    const report = db.sentReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    let tableRows = '';
    (report.entries || []).forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }
        const dayName = getDayName(item.date, false);
        tableRows += `<tr>
            <td>${idx + 1}</td>
            <td>${dayName} - ${item.date}</td>
            <td>${employee.employeeNumber || ''}</td>
            <td>${employee.name}</td>
            <td>${statusLabel}</td>
            <td>${periodLabel}</td>
            <td>${item.notes || '-'}</td>
        </tr>`;
    });

    const now = new Date();
    const dateStr = now.toLocaleDateString('ar-EG');
    const title = `تقرير التعقيب المرسل - ${report.branchName}`;

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    const footerRowCount = tableRows.split('<tr>').length - 1;
    // const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="7"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
        .header { text-align: center; margin-bottom: 15px; }
        .header h1 { font-size: 18px; margin: 5px 0; }
        .header p { font-size: 13px; color: #555; margin: 3px 0; }
    </style>
</head>
<body>
    <div class="header">
        ${logoHtml}
        <h1>${companyName}</h1>
        <h2>${title}</h2>
        <p>تاريخ الإرسال: ${report.date} | تاريخ الطباعة: ${dateStr}</p>
        <p>إجمالي السجلات: ${report.entries.length}</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>م</th>
                <th>اليوم / التاريخ</th>
                <th>رقم الموظف</th>
                <th>اسم الموظف</th>
                <th>الحالة</th>
                <th>الفترة</th>
                <th>ملاحظات</th>
            </tr>
        </thead>
        <tbody>
            ${tableRows}
        </tbody>
        ${footerNewHtml}
    </table>
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
}

// ========== View Sent Report (عرض محتوى التعقيب المرسل) ==========
function viewSentReport(reportId) {
    const report = db.sentReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    let html = `<div style="direction:rtl; padding:20px; font-family:Tahoma,sans-serif;">
        <h3 style="text-align:center;">التعقيب المرسل - ${report.branchName}</h3>
        <p style="text-align:center;">تاريخ الإرسال: ${report.date}</p>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <thead>
                <tr style="background:#2c3e50; color:white;">
                    <th style="padding:6px; border:1px solid #333;">م</th>
                    <th style="padding:6px; border:1px solid #333;">اليوم / التاريخ</th>
                    <th style="padding:6px; border:1px solid #333;">رقم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">اسم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">الحالة</th>
                    <th style="padding:6px; border:1px solid #333;">الفترة</th>
                    <th style="padding:6px; border:1px solid #333;">ملاحظات</th>
                </tr>
            </thead>
            <tbody>`;

    report.entries.forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }
        const dayName = getDayName(item.date, false);
        html += `<tr${idx % 2 === 0 ? ' style="background:#f2f2f2;"' : ''}>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${idx + 1}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${dayName} - ${item.date}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.employeeNumber || ''}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.name}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${statusLabel}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${periodLabel}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${item.notes || '-'}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;

    // عرض المحتوى في نافذة منبثقة
    const previewDiv = document.createElement('div');
    previewDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
    previewDiv.innerHTML = `
        <div style="background:#fff;width:90%;max-width:1000px;max-height:90vh;overflow:auto;padding:20px;border-radius:8px;direction:rtl;">
            <div style="text-align:left;margin-bottom:10px;">
                <button onclick="this.closest('div[style]').remove()" style="padding:8px 20px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;">إغلاق</button>
            </div>
            ${html}
        </div>`;
    document.body.appendChild(previewDiv);
}

// ========== View Archived Report (عرض محتوى التقرير المؤرشف) ==========
function viewArchivedReport(reportId) {
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    let html = `<div style="direction:rtl; padding:20px; font-family:Tahoma,sans-serif;">
        <h3 style="text-align:center;">التقرير المؤرشف - ${report.branchName}</h3>
        <p style="text-align:center;">تاريخ الأرشفة: ${report.date}</p>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <thead>
                <tr style="background:#2c3e50; color:white;">
                    <th style="padding:6px; border:1px solid #333;">م</th>
                    <th style="padding:6px; border:1px solid #333;">اليوم / التاريخ</th>
                    <th style="padding:6px; border:1px solid #333;">رقم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">اسم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">الحالة</th>
                    <th style="padding:6px; border:1px solid #333;">الفترة</th>
                    <th style="padding:6px; border:1px solid #333;">ملاحظات</th>
                </tr>
            </thead>
            <tbody>`;

    const entries = report.entries || [];
    entries.forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }
        const dayName = getDayName(item.date, false);
        html += `<tr${idx % 2 === 0 ? ' style="background:#f2f2f2;"' : ''}>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${idx + 1}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${dayName} - ${item.date}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.employeeNumber || ''}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.name}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${statusLabel}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${periodLabel}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${item.notes || '-'}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;

    const previewDiv = document.createElement('div');
    previewDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
    previewDiv.innerHTML = `
        <div style="background:#fff;width:90%;max-width:1000px;max-height:90vh;overflow:auto;padding:20px;border-radius:8px;direction:rtl;">
            <div style="text-align:left;margin-bottom:10px;">
                <button onclick="this.closest('div[style]').remove()" style="padding:8px 20px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;">إغلاق</button>
            </div>
            ${html}
        </div>`;
    document.body.appendChild(previewDiv);
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
        const value = (item.period === 'all' || !item.period) ? 1 : 0.5;
        const rec = { id: 'a' + Date.now() + Math.random().toString(36).slice(2), empId: item.empId, date: item.date, value: value, type: item.statusType };
        addOrReplaceAbsenceRecord(rec);
    });

    const pdfContent = buildArchivePdf(reportId, branchName, records);
    downloadBlob(pdfContent, fileName, 'application/pdf');

    db.dailyFollowUps = db.dailyFollowUps.filter(item => !records.includes(item));
    saveDB();
    alert('تم ترحيل التعقيب وإنشاء ملف PDF للأرشفة.');
}

// الكود الأصلي: buildArchivePdf كان يبني PDF باستخدام أوامر PDF الأولية (نصوص فقط)
// تم تعطيله والاستعاضة عنه بدالة buildArchiveHtmlPdf التي تبني ملف HTML منظم
/*
function buildArchivePdf(reportId, branchName, records) {
    // ... الكود الأصلي ...
}
function getByteLength(str) {
    return new TextEncoder().encode(str).length;
}
function escapePdfText(text) {
    return text.replace(/([\\()])/g, '\\$1');
}
*/

// === التعديل الجديد: بناء ملف PDF منظم ومقروء باستخدام HTML ===
function buildArchivePdf(reportId, branchName, records) {
    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const now = new Date();
    const nowDateStr = now.toLocaleDateString('ar-EG');
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:80px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    // بناء صفوف الجدول
    let tableRows = '';
    records.forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }
        const itemValue = item.value || 1;
        const dayName = getDayName(item.date, false);
        tableRows += `<tr>
            <td>${idx + 1}</td>
            <td>${dayName} - ${item.date}</td>
            <td>${employee.employeeNumber || ''}</td>
            <td>${employee.name}</td>
            <td>${statusLabel}</td>
            <td>${periodLabel}</td>
            <td>${itemValue}</td>
            <td>${item.notes || '-'}</td>
        </tr>`;
    });

    const htmlContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>تقرير أرشفة التعقيب المرحل</title>
    <style>
        @page { size: A4 landscape; margin: 12mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; margin: 0; padding: 10px; direction: rtl; }
        .header { text-align: center; margin-bottom: 15px; }
        .header h1 { font-size: 18px; margin: 5px 0; }
        .header p { font-size: 13px; color: #555; margin: 3px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th { background-color: #2c3e50; color: white; padding: 6px 4px; border: 1px solid #333; text-align: center; }
        td { padding: 4px; border: 1px solid #666; text-align: center; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        .footer { margin-top: 15px; font-size: 11px; color: #888; text-align: center; }
    </style>
</head>
<body>
    <div class="header">
        ${logoHtml}
        <h1>${companyName}</h1>
        <h2>تقرير أرشفة التعقيب المرحل</h2>
        <p>الفرع: ${branchName} | تاريخ التقرير: ${nowDateStr}</p>
        <p>إجمالي السجلات: ${records.length}</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>م</th>
                <th>اليوم / التاريخ</th>
                <th>رقم الموظف</th>
                <th>اسم الموظف</th>
                <th>الحالة</th>
                <th>الفترة</th>
                <th>القيمة</th>
                <th>ملاحظات</th>
            </tr>
        </thead>
        <tbody>
            ${tableRows}
        </tbody>
    </table>
    <div class="footer">
        <p>تم إنشاء هذا التقرير بواسطة نظام تعقيب الموظفين - Tageep</p>
    </div>
</body>
</html>`;
    return htmlContent;
}

function getByteLength(str) {
    return new TextEncoder().encode(str).length;
}

function escapePdfText(text) {
    return text.replace(/([\\()])/g, '\\$1');
}

// === دالة تعديل التعقيب المرحل: تعديل مباشر على بيانات التعقيب المؤرشف ===
// الكود الأصلي: كان هناك دالة restoreArchivedReport تستعيد السجلات إلى التعقيب اليومي
// تم استبدالها بدالة تعديل مباشر
function editArchivedReport(reportId) {
    if (!canPerform('archive', 'edit')) return alert('ليس لديك صلاحية لتعديل التعقيب المرحل');
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // إنشاء نافذة التعديل المنبثقة
    let html = `<div style="direction:rtl; padding:20px; font-family:Tahoma,sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #2c3e50; padding-bottom:10px; margin-bottom:15px;">
            <h3 style="margin:0;">✏️ تعديل التعقيب المرحل - ${report.branchName}</h3>
            <span onclick="closeEditArchivedModal()" style="font-size:28px; font-weight:bold; color:#e74c3c; cursor:pointer; padding:0 10px;">&times;</span>
        </div>
        <p style="text-align:center;">تاريخ الأرشفة: ${report.date} | إجمالي السجلات: ${(report.entries || []).length}</p>
        <p style="text-align:center; color:#666; font-size:13px;">قم بتعديل البيانات ثم اضغط "حفظ التعديلات" لتحديث التعقيب الرئيسي والمرسل تلقائياً.</p>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
            <thead>
                <tr style="background:#2c3e50; color:white;">
                    <th style="padding:6px; border:1px solid #333;">م</th>
                    <th style="padding:6px; border:1px solid #333;">التاريخ</th>
                    <th style="padding:6px; border:1px solid #333;">رقم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">اسم الموظف</th>
                    <th style="padding:6px; border:1px solid #333;">الحالة</th>
                    <th style="padding:6px; border:1px solid #333;">الفترة</th>
                    <th style="padding:6px; border:1px solid #333;">ملاحظات</th>
                </tr>
            </thead>
            <tbody>`;

    const entries = report.entries || [];
    entries.forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusOptions = ['present', 'absent', 'annual', 'holiday_present']
            .map(s => `<option value="${s}" ${item.statusType === s ? 'selected' : ''}>${s === 'present' ? 'حاضر' : s === 'absent' ? 'غائب' : s === 'annual' ? 'إجازة سنوية' : 'مناسبة'
                }</option>`).join('');

        // إنشاء خيارات الفترة
        let periodOptions = '<option value="all">الكل</option>';
        const emp = employee.id ? db.employees.find(e => e.id === item.empId) : null;
        const shift = emp ? db.workShifts.find(s => s.id === emp.shiftId) : null;
        if (shift && shift.periods && shift.periods.length) {
            shift.periods.forEach(p => {
                periodOptions += `<option value="${p.id}" ${item.period === p.id ? 'selected' : ''}>${p.name}</option>`;
            });
        }

        const dayName = getDayName(item.date, false);
        html += `<tr${idx % 2 === 0 ? ' style="background:#f2f2f2;"' : ''}>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${idx + 1}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <input type="date" id="editDate_${idx}" value="${item.date}" style="width:130px; padding:3px; border:1px solid #ccc; border-radius:3px;">
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.employeeNumber || ''}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">${employee.name}</td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <select id="editStatus_${idx}" style="padding:4px; border:1px solid #ccc; border-radius:3px;">
                    ${statusOptions}
                </select>
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <select id="editPeriod_${idx}" style="padding:4px; border:1px solid #ccc; border-radius:3px;">
                    ${periodOptions}
                </select>
            </td>
            <td style="padding:4px; border:1px solid #666; text-align:center;">
                <input type="text" id="editNotes_${idx}" value="${item.notes || ''}" style="width:90%; padding:4px; border:1px solid #ccc; border-radius:3px;" placeholder="ملاحظات...">
            </td>
        </tr>`;
    });

    html += `</tbody></table>
        <div style="text-align:center; margin-top:20px;">
            <button onclick="saveArchivedReportEdits('${reportId}')" style="padding:10px 30px; background-color:#27ae60; color:white; border:none; border-radius:4px; cursor:pointer; font-size:14px; font-weight:bold;">💾 حفظ التعديلات</button>
            <button onclick="closeEditArchivedModal()" style="padding:10px 20px; background-color:#e74c3c; color:white; border:none; border-radius:4px; cursor:pointer; margin-right:10px;">إلغاء</button>
        </div>
    </div>`;

    const modalDiv = document.createElement('div');
    modalDiv.id = 'editArchivedModal';
    modalDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
    modalDiv.innerHTML = `
        <div style="background:#fff;width:90%;max-width:1200px;max-height:90vh;overflow:auto;padding:20px;border-radius:8px;direction:rtl;">
            ${html}
        </div>`;
    document.body.appendChild(modalDiv);
}

// دالة إغلاق نافذة تعديل التعقيب المرحل
function closeEditArchivedModal() {
    const modal = document.getElementById('editArchivedModal');
    if (modal) modal.remove();
}

// دالة حفظ تعديلات التعقيب المرحل
function saveArchivedReportEdits(reportId) {
    if (!canPerform('archive', 'edit')) return alert('ليس لديك صلاحية لتعديل التعقيب المرحل');
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // جمع التعديلات من النموذج
    const entries = report.entries || [];
    const changes = [];

    entries.forEach((item, idx) => {
        const statusSelect = document.getElementById(`editStatus_${idx}`);
        const periodSelect = document.getElementById(`editPeriod_${idx}`);
        const notesInput = document.getElementById(`editNotes_${idx}`);
        const dateInput = document.getElementById(`editDate_${idx}`);
        if (!statusSelect) return;

        const newStatus = statusSelect.value;
        const newPeriod = periodSelect ? periodSelect.value : (item.period || 'all');
        const newNotes = notesInput ? notesInput.value.trim() : '';
        const newDate = dateInput ? dateInput.value : item.date;

        // تحقق مما إذا كانت القيمة تغيرت
        if (newStatus !== item.statusType || newNotes !== (item.notes || '') || newDate !== item.date || newPeriod !== (item.period || 'all')) {
            changes.push({
                empId: item.empId,
                oldDate: item.date,
                newDate: newDate,
                oldStatus: item.statusType,
                newStatus: newStatus,
                oldPeriod: item.period || 'all',
                newPeriod: newPeriod,
                oldNotes: item.notes || '',
                newNotes: newNotes
            });

            // تحديث السجل في archivedReports
            item.statusType = newStatus;
            item.notes = newNotes;
            item.date = newDate;
            item.period = newPeriod;
        }
    });

    if (!changes.length) {
        alert('لم يتم إجراء أي تغييرات.');
        document.querySelector('div[style*="position:fixed"][style*="z-index:2000"]')?.remove();
        return;
    }

    // تحديث البيانات في التعقيب الرئيسي (absences)
    changes.forEach(change => {
        // البحث عن السجل في absences بالتاريخ القديم (قبل التعديل)
        const mainRec = db.absences.find(a => a.empId === change.empId && a.date === change.oldDate);

        // معالجة رصيد الإجازات السنوية للسجل القديم
        if (mainRec) {
            // إذا كان السجل القديم إجازة سنوية، نعيد الرصيد
            if (mainRec.type === 'annual') {
                const empObj = findEmployeeById(change.empId);
                if (empObj) {
                    empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) + parseFloat(mainRec.value || 1);
                }
            }
            // حذف السجل القديم
            db.absences = db.absences.filter(a => !(a.id === mainRec.id));
        }

        // إضافة السجل الجديد إذا لم يكن حاضراً
        if (change.newStatus !== 'present') {
            // إذا كان التعديل إلى إجازة سنوية، نخصم الرصيد
            if (change.newStatus === 'annual') {
                const empObj = findEmployeeById(change.empId);
                if (empObj) {
                    const val = 1;
                    if (empObj.leaveBalance < val) {
                        alert(`⚠️ رصيد الإجازة السنوية للموظف ${getEmployeeLabel(change.empId)} لا يكفي (المتبقي: ${empObj.leaveBalance}).`);
                    }
                    empObj.leaveBalance = Math.max(0, parseFloat(empObj.leaveBalance || 0) - val);
                }
            }

            const rec = {
                id: 'a' + Date.now() + Math.random().toString(36).slice(2),
                empId: change.empId,
                date: change.newDate,
                value: 1,
                type: change.newStatus
            };
            addOrReplaceAbsenceRecord(rec);
        }
    });

    // تحديث البيانات في sentReports
    db.sentReports.forEach(sentReport => {
        if (sentReport.status === 'transferred') return;

        sentReport.entries.forEach(entry => {
            const change = changes.find(c => c.empId === entry.empId && c.oldDate === entry.date);
            if (change) {
                entry.statusType = change.newStatus;
                entry.notes = change.newNotes;
                entry.date = change.newDate;
                entry.period = change.newPeriod;
            }
        });
    });

    saveDB();

    // إغلاق النافذة المنبثقة
    closeEditArchivedModal();

    // عرض ملخص التغييرات
    let summaryMsg = '✅ تم حفظ التعديلات بنجاح!\n\n';
    changes.forEach((c, i) => {
        const emp = findEmployeeById(c.empId);
        const empName = emp ? emp.name : c.empId;
        const statusLabels = { present: 'حاضر', absent: 'غائب', annual: 'إجازة سنوية', holiday_present: 'مناسبة' };
        const dateChanged = c.oldDate !== c.newDate ? ` (${c.oldDate} → ${c.newDate})` : ` (${c.oldDate})`;
        summaryMsg += i + 1 + '. ' + empName + dateChanged + ': ' + (statusLabels[c.oldStatus] || c.oldStatus) + ' → ' + (statusLabels[c.newStatus] || c.newStatus) + '\n';
    });
    summaryMsg += '\n📌 تم تحديث:\n- التعقيب المؤرشف ✅\n- التعقيب الرئيسي ✅\n- التعقيب المرسل ✅';

    alert(summaryMsg);

    // تحديث الواجهات
    renderArchiveReports();
    renderMainTable();
    renderSentReports();
}

// === دالة طباعة جدول التعقيب اليومي ===
function printDailyTable() {
    if (!canPerform('daily', 'view')) return alert('ليس لديك صلاحية لعرض التعقيب اليومي');

    const dailyTable = document.querySelector('#daily-followup-panel .table-wrapper table');
    if (!dailyTable) return alert('لا يوجد جدول للطباعة');

    const from = document.getElementById('dailyFilterFrom').value;
    const to = document.getElementById('dailyFilterTo').value;
    const dateRangeText = from && to ? `من ${from} إلى ${to}` : 'التعقيب اليومي';

    const tableClone = dailyTable.cloneNode(true);
    const rows = tableClone.querySelectorAll('tr');
    rows.forEach(row => {
        const lastCell = row.querySelector('td:last-child, th:last-child');
        if (lastCell && lastCell.classList.contains('no-print')) {
            lastCell.remove();
        }
    });

    const firstRow = tableClone.querySelector('tr');
    const colCount = firstRow ? firstRow.cells.length : 1;

    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    const originalThead = tableClone.querySelector('thead');
    let columnHeadersHtml = '';
    if (originalThead) {
        columnHeadersHtml = originalThead.querySelector('tr').outerHTML;
    }

    const headerRowHtml = `<tr style="display:table-row;">
        <td colspan="${colCount}" style="text-align:center;border:0!important;padding:0!important;">
            ${logoHtml}
            <div style="font-size:16px;font-weight:bold;margin:3px 0;">${companyName}</div>
            <div style="font-size:14px;font-weight:bold;margin:2px 0;">التعقيب اليومي</div>
            <div style="font-size:11px;color:#555;margin-bottom:5px;">${dateRangeText}</div>
        </td>
    </tr>`;

    const fullTheadHtml = `<thead>${headerRowHtml}${columnHeadersHtml}</thead>`;
    const tableHtml = tableClone.outerHTML;
    const finalHtml = tableHtml.replace(/<thead>[\s\S]*?<\/thead>/, fullTheadHtml);

    // const printFooter = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const finalHtmlWithFooter = finalHtml.replace('</table>', printFooter + '</table>');

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;
        const finalHtmlWithFooter = finalHtml + footerNewHtml;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>طباعة التعقيب اليومي</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
    </style>
</head>
<body>
    ${finalHtmlWithFooter}
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
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
    const canDelete = canPerform('archive', 'delete');
    const canEdit = canPerform('archive', 'edit');

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
                <td class="no-print">
                    ${canDelete ? `<button onclick="deleteArchivedReport('${report.id}')" class="btn-danger" style="margin-left:4px;">🗑️ حذف</button>` : ''}
                    ${canEdit ? `<button onclick="editArchivedReport('${report.id}')" class="btn-warning" style="margin-right:4px;">✏️ تعديل</button>` : ''}
                    <button onclick="previewArchivedReport('${report.id}')" style="margin-right:4px;">🖨️ معاينة الطباعة</button>
                </td>
            </tr>
        `;
    });
}

function deleteArchivedReport(reportId) {
    if (!canPerform('archive', 'delete')) return alert('ليس لديك صلاحية لحذف التعقيب المؤرشف');
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // رسالة تأكيد الحذف مع تفاصيل التقرير
    const msg = `🗑️ تأكيد حذف التعقيب المؤرشف\n\nالفرع: ${report.branchName}\nالتاريخ: ${report.date}\nعدد السجلات: ${report.entries.length}\n\nسيتم حذف البيانات من جميع جداول النظام وتحديث رصيد الإجازات.\nهل أنت متأكد من الحذف؟`;
    if (!confirm(msg)) return;

    // 1. إعادة رصيد الإجازات للسجلات من نوع annual
    (report.entries || []).forEach(item => {
        if (item.statusType === 'annual') {
            const empObj = findEmployeeById(item.empId);
            if (empObj) {
                empObj.leaveBalance = parseFloat(empObj.leaveBalance || 0) + 1;
            }
        }
    });

    // 2. حذف السجلات من التعقيب الرئيسي (absences)
    (report.entries || []).forEach(item => {
        if (item.statusType !== 'present') {
            db.absences = db.absences.filter(a => !(a.empId === item.empId && a.date === item.date));
        }
    });

    // 3. حذف التقرير من التقرير المؤرشفة
    db.archivedReports = db.archivedReports.filter(r => r.id !== reportId);

    // 4. حذف التقرير من التعقيب المرسل إذا كان موجوداً
    db.sentReports = db.sentReports.filter(sr => {
        if (sr.status === 'transferred') {
            // مقارنة السجلات لتحديد إذا كان هذا التقرير مرتبطاً
            const isRelated = sr.entries.length === report.entries.length &&
                sr.entries.every((entry, idx) =>
                    entry.empId === report.entries[idx]?.empId &&
                    entry.date === report.entries[idx]?.date
                );
            return !isRelated;
        }
        return true;
    });

    saveDB();
    renderArchiveReports();
    renderMainTable();
    renderSentReports();
    alert(`✅ تم حذف التقرير المؤرشف (${report.branchName}) بنجاح من جميع جداول النظام.`);
}

function previewArchivedReport(reportId) {
    const report = db.archivedReports.find(r => r.id === reportId);
    if (!report) return alert('التقرير غير موجود');

    // بناء محتوى الطباعة باستخدام نفس طريقة printVisibleTable / buildArchivePdf
    const companyName = db.settings.companyName || '';
    const logoUrl = db.settings.logo || '';
    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" style="width:100%;height:auto;max-height:60px;object-fit:contain;display:block;margin:0 auto 8px;" alt="شعار الشركة">`
        : '';

    // بناء جدول التعقيب المؤرشف
    let tableRows = '';
    (report.entries || []).forEach((item, idx) => {
        const employee = db.employees.find(e => e.id === item.empId) || { name: '-', employeeNumber: '-' };
        const statusLabel = item.statusType === 'present' ? 'حاضر' : item.statusType === 'absent' ? 'غائب' : item.statusType === 'annual' ? 'إجازة سنوية' : item.statusType === 'other_leave' ? 'إجازة أخرى' : 'مناسبة';
        let periodLabel = 'الكل';
        if (item.period && item.period !== 'all') {
            const emp = db.employees.find(e => e.id === item.empId);
            const shift = db.workShifts.find(s => s.id === (emp && emp.shiftId));
            const p = shift?.periods?.find(pp => pp.id === item.period);
            periodLabel = p?.name || item.period;
        }
        const dayName = getDayName(item.date, false);
        const itemValue = item.value || 1;
        tableRows += `<tr>
            <td>${idx + 1}</td>
            <td>${dayName} - ${item.date}</td>
            <td>${employee.employeeNumber || ''}</td>
            <td>${employee.name}</td>
            <td>${statusLabel}</td>
            <td>${periodLabel}</td>
            <td>${itemValue}</td>
            <td>${item.notes || '-'}</td>
        </tr>`;
    });

    const now = new Date();
    const dateStr = now.toLocaleDateString('ar-EG');
    const title = `تقرير التعقيب المؤرشف - ${report.branchName}`;

    const orientation = localStorage.getItem('tageep_orientation') || 'landscape';
    const paperSize = localStorage.getItem('tageep_paper_size') || 'A4';

    const paperSizeStyles = {
        'A4': { width: '210mm', height: '297mm' },
        'A5': { width: '148mm', height: '210mm' },
        'Letter': { width: '216mm', height: '279mm' },
        'Legal': { width: '216mm', height: '356mm' }
    };
    const selectedSize = paperSizeStyles[paperSize] || paperSizeStyles['A4'];
    const isPortrait = orientation === 'portrait';
    const fontSize = isPortrait ? '8px' : '10px';
    const cellPadding = isPortrait ? '2px 3px' : '4px 6px';
    const headerFontSize = isPortrait ? '9px' : '11px';

    // const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="8"><div class="print-footer">
    //     <span class="signature">رئيس قسم الموارد البشرية</span>
    //     <span class="signature">رئيس قسم الحسابات</span>
    //     <span class="signature">المراجعة</span>
    //     <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
    // </div></td></tr></tfoot>`;

    // const printContent = `<!DOCTYPE html>
            // ==================== تعديل الفوتر ====================
        // الكود القديم (معطل): كان يضيف الفوتر داخل <tfoot> مما يسبب تكراره في كل صفحة.
        // يمكنك إعادة تفعيله بإلغاء تعليق الأسطر أدناه وتعليق الأسطر الجديدة.
        /*
        const footerHtml = `<tfoot class="print-footer-row"><tr><td colspan="${colCount}"><div class="print-footer">
            <span class="signature">رئيس قسم الموارد البشرية</span>
            <span class="signature">رئيس قسم الحسابات</span>
            <span class="signature">المراجعة</span>
            <span class="signature">نائب المدير العام للشؤون المالية والإدارية</span>
        </div></td></tr></tfoot>`;
        const finalHtmlWithFooter = finalHtml.replace('</table>', footerHtml + '</table>');
        */
        
        // الكود الجديد: الفوتر خارج الجدول (بعد </table>) بحيث يظهر مرة واحدة فقط في آخر صفحة.
        // الفوتر في صف واحد بأربعة أعمدة.
        const footerNewHtml = `
        <div class="print-footer-new" style="width:100%;margin-top:10px;page-break-inside:avoid;">
            <table style="width:100%;border-collapse:collapse;font-size:${fontSize};">
              <tr style="height: 80px; vertical-align: top;">
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الموارد البشرية</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">رئيس قسم الحسابات</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">المراجعة</td>
                    <td style="padding:${cellPadding};text-align:right;border:1px solid #000;font-weight:bold;width:25%;">نائب المدير العام للشؤون المالية والإدارية</td>
                </tr>
            </table>
        </div>`;

        const printContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        @page { size: ${orientation === 'landscape' ? selectedSize.height + ' ' + selectedSize.width : selectedSize.width + ' ' + selectedSize.height}; margin: 10mm; }
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: ${fontSize}; }
        th, td { padding: ${cellPadding}; text-align: center; border: 1px solid #000; word-break: keep-all; }
        th { background-color: #dcedc8; font-weight: bold; font-size: ${headerFontSize}; }
        thead { display: table-header-group; }
        thead th, thead td { position: static !important; }
        thead img { max-height: 50px !important; }
        tr { page-break-inside: auto; break-inside: auto; }
        tbody tr { orphans: 2; widows: 2; }
        .header { text-align: center; margin-bottom: 15px; }
        .header h1 { font-size: 18px; margin: 5px 0; }
        .header p { font-size: 13px; color: #555; margin: 3px 0; }
    </style>
</head>
<body>
    <div class="header">
        ${logoHtml}
        <h1>${companyName}</h1>
        <h2>${title}</h2>
        <p>تاريخ الأرشفة: ${report.date} | تاريخ الطباعة: ${dateStr}</p>
        <p>إجمالي السجلات: ${report.entries.length}</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>م</th>
                <th>اليوم / التاريخ</th>
                <th>رقم الموظف</th>
                <th>اسم الموظف</th>
                <th>الحالة</th>
                <th>الفترة</th>
                <th>القيمة</th>
                <th>ملاحظات</th>
            </tr>
        </thead>
        <tbody>
            ${tableRows}
        </tbody>
        ${footerNewHtml}
    </table>
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
            try { printFrame.contentWindow.print(); } catch (e) { window.print(); }
            setTimeout(() => { document.body.removeChild(printFrame); }, 1000);
        }, 500);
        return;
    }

    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 1000);
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
    // عرض المحتوى المناسب حسب التاب
    switch (tabId) {
        case 'tab-main':
            renderMainTable();
            renderReportTable();
            break;
        case 'tab-daily':
            renderDailyFollowups();
            renderDailyExtras();
            // تعديل جديد: تحديث السلف عند فتح تبويب التعقيب اليومي.
            renderDailyAdvances();
            break;
        case 'tab-archive':
            renderArchiveReports();
            break;
        case 'tab-sent':
            renderSentReports();
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
    const bootScreen = document.getElementById('bootScreen');
    if (bootScreen) bootScreen.style.display = 'none';
    document.getElementById('loginMessage').innerText = message || '';
    document.getElementById('licenseScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
}

function showApp() {
    const bootScreen = document.getElementById('bootScreen');
    if (bootScreen) bootScreen.style.display = 'none';
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

function showCachedAppIfPossible() {
    const savedUserId = localStorage.getItem('appCurrentUserId');
    const savedToken = localStorage.getItem('appAccessToken');
    const local = localStorage.getItem('tageep_state');
    if (!savedToken || !savedUserId || !local) return false;

    try {
        normalizeAppState(JSON.parse(local));
        const savedUser = db.users.find(user => user.id === savedUserId);
        if (!savedUser) return false;
        currentUser = savedUser;
        showApp();
        return true;
    } catch (error) {
        console.warn('Failed to show cached Tageep state:', error);
        return false;
    }
}

async function bootApp() {
    const showedCachedApp = showCachedAppIfPossible();
    try {
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
                if (showedCachedApp) return;
            }
        }
        if (showedCachedApp) return;
        localStorage.removeItem('appAccessToken');
        localStorage.removeItem('appCurrentUserId');
        showLogin();
    } catch (error) {
        console.error('API load failed:', error);
        if (showedCachedApp) return;
        localStorage.removeItem('appAccessToken');
        localStorage.removeItem('appCurrentUserId');
        showLogin('تم فتح النظام بدون الاتصال بالحالة البعيدة. يمكنك تسجيل الدخول والمتابعة.');
    }
}

// ========== ميزة إظهار/إخفاء الأعمدة في الجداول ==========
// حفظ حالة إخفاء الأعمدة لكل جدول في localStorage
// المفتاح: hideCols_[tableId] والقيمة: JSON.stringify([colIndex1, colIndex2, ...])

// إضافة أزرار إظهار/إخفاء الأعمدة إلى ترويسة الجدول
function enableColumnToggleForTable(table, tableKey) {
    if (!table || table.dataset.toggleEnabled === 'true') return;
    table.dataset.toggleEnabled = 'true';

    // استرجاع الحالة المحفوظة
    const savedKey = `hideCols_${tableKey}`;
    const savedKeysKey = `hideColKeys_${tableKey}`;
    let hiddenCols = [];
    let hiddenColKeys = [];
    try {
        const saved = localStorage.getItem(savedKey);
        if (saved) hiddenCols = JSON.parse(saved);
        const savedKeys = localStorage.getItem(savedKeysKey);
        if (savedKeys) hiddenColKeys = JSON.parse(savedKeys);
    } catch (e) { }

    const headers = table.querySelectorAll('thead th, thead td');

    // إضافة أيقونة العين لكل عنوان عمود قابل للإخفاء
    headers.forEach((header, idx) => {
        if (header.classList.contains('no-print')) return;
        if (header.classList.contains('dyn-date')) return;
        if (header.classList.contains('dyn-date-cell')) return;

        // إضافة زر العين
        const eyeBtn = document.createElement('span');
        eyeBtn.className = 'col-toggle-btn';
        eyeBtn.title = 'إظهار/إخفاء العمود';
        eyeBtn.style.cssText = 'cursor:pointer;margin-right:4px;font-size:13px;user-select:none;display:inline-block;';
        eyeBtn.dataset.colIndex = idx;
        eyeBtn.dataset.colKey = getColumnStorageKey(header, idx);

        const isHidden = hiddenColKeys.length
            ? hiddenColKeys.includes(eyeBtn.dataset.colKey)
            : (!['main', 'report'].includes(tableKey) && hiddenCols.includes(idx));
        eyeBtn.textContent = isHidden ? '👁️‍🗨️' : '👁️';
        if (isHidden) eyeBtn.style.opacity = '0.5';

        eyeBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const colIdx = parseInt(this.dataset.colIndex);
            toggleColumn(table, tableKey, colIdx, this, this.dataset.colKey);
        });

        // إضافة الزر قبل نص العنوان
        header.insertBefore(eyeBtn, header.firstChild);

        // تطبيق الإخفاء على العمود
        if (isHidden) {
            setColumnVisibility(table, idx, false);
        }
    });

    // إضافة زر إعادة تعيين الإخفاء بجانب الجدول
    const wrapper = table.closest('.table-wrapper') || table.parentElement;
    if (wrapper && !wrapper.querySelector('.col-toggle-reset-btn')) {
        const resetBtn = document.createElement('button');
        resetBtn.className = 'col-toggle-reset-btn';
        resetBtn.textContent = '👁️ إظهار الكل';
        resetBtn.style.cssText = 'font-size:11px;padding:2px 8px;margin-bottom:4px;border:1px solid #ccc;border-radius:3px;cursor:pointer;background:#f9f9f9;';
        resetBtn.addEventListener('click', function (e) {
            e.preventDefault();
            resetAllColumns(table, tableKey);
        });
        wrapper.insertBefore(resetBtn, wrapper.firstChild);
    }
}

function getColumnStorageKey(header, idx) {
    const clone = header.cloneNode(true);
    clone.querySelectorAll('.col-toggle-btn, .sort-arrow').forEach(el => el.remove());
    const label = clone.textContent.replace(/\s+/g, ' ').trim();
    return label ? `label:${label}` : `index:${idx}`;
}

// تبديل إخفاء/إظهار عمود
function toggleColumn(table, tableKey, colIndex, eyeBtn, colKey) {
    const savedKey = `hideCols_${tableKey}`;
    const savedKeysKey = `hideColKeys_${tableKey}`;
    let hiddenCols = [];
    let hiddenColKeys = [];
    try {
        const saved = localStorage.getItem(savedKey);
        if (saved) hiddenCols = JSON.parse(saved);
        const savedKeys = localStorage.getItem(savedKeysKey);
        if (savedKeys) hiddenColKeys = JSON.parse(savedKeys);
    } catch (e) { }

    const key = colKey || (eyeBtn && eyeBtn.dataset.colKey) || getColumnStorageKey(table.querySelectorAll('thead th, thead td')[colIndex], colIndex);
    const isCurrentlyHidden = hiddenColKeys.length
        ? hiddenColKeys.includes(key)
        : (!['main', 'report'].includes(tableKey) && hiddenCols.includes(colIndex));

    if (isCurrentlyHidden) {
        // إظهار العمود
        hiddenCols = hiddenCols.filter(i => i !== colIndex);
        hiddenColKeys = hiddenColKeys.filter(item => item !== key);
        setColumnVisibility(table, colIndex, true);
        if (eyeBtn) {
            eyeBtn.textContent = '👁️';
            eyeBtn.style.opacity = '1';
        }
    } else {
        // إخفاء العمود
        hiddenCols.push(colIndex);
        hiddenColKeys.push(key);
        setColumnVisibility(table, colIndex, false);
        if (eyeBtn) {
            eyeBtn.textContent = '👁️‍🗨️';
            eyeBtn.style.opacity = '0.5';
        }
    }

    localStorage.setItem(savedKey, JSON.stringify([...new Set(hiddenCols)]));
    localStorage.setItem(savedKeysKey, JSON.stringify([...new Set(hiddenColKeys)]));
}

// تطبيق الإخفاء/الإظهار على جميع خلايا العمود
function setColumnVisibility(table, colIndex, visible) {
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
        const cell = row.children[colIndex];
        if (cell) {
            cell.style.display = visible ? '' : 'none';
        }
    });
}

// إعادة تعيين جميع الأعمدة المخفية
function resetAllColumns(table, tableKey) {
    const savedKey = `hideCols_${tableKey}`;
    const savedKeysKey = `hideColKeys_${tableKey}`;
    localStorage.removeItem(savedKey);
    localStorage.removeItem(savedKeysKey);

    // إظهار جميع الأعمدة
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
        Array.from(row.children).forEach(cell => {
            cell.style.display = '';
        });
    });

    // تحديث أيقونات العين
    const eyeBtns = table.querySelectorAll('.col-toggle-btn');
    eyeBtns.forEach(btn => {
        btn.textContent = '👁️';
        btn.style.opacity = '1';
    });
}

// تفعيل إظهار/إخفاء الأعمدة على جميع الجداول المهمة
function enableColumnToggleForAllTables() {
    // جدول التعقيب الرئيسي
    const mainTable = document.querySelector('#tab-main .main-panel.active table');
    if (mainTable) enableColumnToggleForTable(mainTable, 'main');

    // جدول التقرير
    const reportTable = document.querySelector('#report-panel .table-wrapper table');
    if (reportTable) enableColumnToggleForTable(reportTable, 'report');
}

function applySavedColumnVisibilityForTable(table, tableKey) {
    if (!table) return;
    const savedKey = `hideCols_${tableKey}`;
    const savedKeysKey = `hideColKeys_${tableKey}`;
    let hiddenCols = [];
    let hiddenColKeys = [];
    try {
        const saved = localStorage.getItem(savedKey);
        if (saved) hiddenCols = JSON.parse(saved);
        const savedKeys = localStorage.getItem(savedKeysKey);
        if (savedKeys) hiddenColKeys = JSON.parse(savedKeys);
    } catch (e) { }

    const headerCells = table.querySelectorAll('thead th, thead td');
    headerCells.forEach((header, idx) => {
        const key = getColumnStorageKey(header, idx);
        const isHidden = hiddenColKeys.length
            ? hiddenColKeys.includes(key)
            : (!['main', 'report'].includes(tableKey) && hiddenCols.includes(idx));
        setColumnVisibility(table, idx, !isHidden);
        const eyeBtn = header.querySelector('.col-toggle-btn');
        if (eyeBtn) {
            eyeBtn.dataset.colIndex = idx;
            eyeBtn.dataset.colKey = key;
            eyeBtn.textContent = isHidden ? '👁️‍🗨️' : '👁️';
            eyeBtn.style.opacity = isHidden ? '0.5' : '1';
        }
    });
}

function refreshMainAndReportTablesUI() {
    const mainTable = document.querySelector('#attendance-panel .table-wrapper table');
    if (mainTable) {
        applySavedColumnVisibilityForTable(mainTable, 'main');
        makeTableSortable(mainTable);
    }

    const reportTable = document.querySelector('#report-panel .table-wrapper table');
    if (reportTable) {
        applySavedColumnVisibilityForTable(reportTable, 'report');
        makeTableSortable(reportTable);
    }
}

// ========== فرز الأعمدة في الجداول (تصاعدي / تنازلي) ==========
// حالة الفرز العالمية
const sortState = {};

// دالة رئيسية لفرز جدول بناءً على عمود
function sortTableData(table, colIndex) {
    if (!table) return;
    const tbl = table;
    const tbody = tbl.querySelector('tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach((row, idx) => {
        if (!row.dataset.originalSortIndex) row.dataset.originalSortIndex = String(idx);
    });
    // استبعاد صف المجموع إن وجد (يبحث في جميع الخلايا عن نص "المجموع")
    let totalRow = null;
    if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        if (lastRow && lastRow.cells.length > 0) {
            const hasTotal = Array.from(lastRow.cells).some(cell => cell.textContent.trim() === 'المجموع');
            if (hasTotal) {
                totalRow = rows.pop();
            }
        }
    }
    if (rows.length <= 1) return;

    // مفتاح الحالة
    const stateKey = tbl.id || ('table_' + Math.random().toString(36).slice(2, 8));
    if (!tbl._sortKey) tbl._sortKey = stateKey;
    if (!sortState[stateKey]) sortState[stateKey] = { colIndex: null, direction: 'none' };
    const currentState = sortState[stateKey];
    const currentDir = currentState.colIndex === colIndex ? currentState.direction : 'none';
    const newDir = currentDir === 'none' ? 'asc' : (currentDir === 'asc' ? 'desc' : 'none');
    sortState[stateKey] = { colIndex: newDir === 'none' ? null : colIndex, direction: newDir };

    // فرز الصفوف
    if (newDir === 'none') {
        rows.sort((a, b) => (parseInt(a.dataset.originalSortIndex, 10) || 0) - (parseInt(b.dataset.originalSortIndex, 10) || 0));
    } else {
        rows.sort((a, b) => {
            const aText = (a.cells[colIndex]?.textContent || '').trim();
            const bText = (b.cells[colIndex]?.textContent || '').trim();
            // محاولة المقارنة كأرقام
            const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''));
            const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''));
            let result;
            if (!isNaN(aNum) && !isNaN(bNum)) {
                result = aNum - bNum;
            } else {
                result = aText.localeCompare(bText, 'ar');
            }
            return newDir === 'asc' ? result : -result;
        });
    }

    // إعادة بناء tbody
    tbody.innerHTML = '';
    rows.forEach(row => tbody.appendChild(row));
    if (totalRow) tbody.appendChild(totalRow);

    // تحديث أيقونات رأس الجدول
    const headerCells = tbl.querySelectorAll('thead th, thead td');
    headerCells.forEach((cell, idx) => {
        cell.classList.remove('sort-asc', 'sort-desc');
        if (idx === colIndex && newDir !== 'none') {
            cell.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
    return newDir;
}

// تفعيل الفرز على جميع جداول الصفحة
function enableTableSorting() {
    const selectors = [
        '#tab-main .table-wrapper table',
        '#tab-employees .table-wrapper table',
        '#tab-branches .table-wrapper table',
        '#tab-users table:not(.no-sort)',
        '#tab-archive table',
        '#settings-subtab-holidays table',
        '#settings-subtab-shifts .table-wrapper table',
        '#daily-followup-panel .table-wrapper table',
        '#daily-extra-panel .table-wrapper table',
        // تعديل جديد: دعم الفرز في جدول السلف.
        '#daily-advance-panel .table-wrapper table',
        '#report-panel .table-wrapper table'
    ];
    selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(table => {
            makeTableSortable(table);
        });
    });
}

// جعل جدول معين قابلاً للفرز
function makeTableSortable(table) {
    if (!table) return;
    table.dataset.sortable = 'true';

    const headers = table.querySelectorAll('thead th, thead td');
    headers.forEach((header, idx) => {
        if (header.classList.contains('no-print')) return;
        if (header.classList.contains('dyn-date')) return;

        header.style.cursor = 'pointer';
        header.style.userSelect = 'none';
        header.title = 'انقر للفرز';

        // إضافة سهم الفرز
        if (!header.querySelector('.sort-arrow')) {
            const arrow = document.createElement('span');
            arrow.className = 'sort-arrow';
            arrow.style.cssText = 'margin-right:4px;font-size:11px;color:#888;';
            arrow.textContent = ' ⇅';
            header.appendChild(arrow);
        }

        // إزالة المستمع القديم وإضافة الجديد
        if (header._sortHandler) {
            header.removeEventListener('click', header._sortHandler);
        }
        header._sortHandler = function (e) {
            e.stopPropagation();
            // فرز الجدول
            const newDir = sortTableData(table, idx);
            // تحديث الأسهم
            headers.forEach((h, i) => {
                const arrowSpan = h.querySelector('.sort-arrow');
                if (arrowSpan) {
                    if (i === idx && newDir !== 'none') {
                        arrowSpan.textContent = newDir === 'asc' ? ' ↑' : ' ↓';
                        arrowSpan.style.color = '#27ae60';
                    } else {
                        arrowSpan.textContent = ' ⇅';
                        arrowSpan.style.color = '#888';
                    }
                }
            });
        };
        header.addEventListener('click', header._sortHandler);
    });
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
