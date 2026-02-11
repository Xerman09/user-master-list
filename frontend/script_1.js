// frontend/script.js
// Works for both index.html (login) and userlist.html (dashboard).

const API_BASE = ''; // same-origin

// ---------- Helpers ----------
const $ = sel => document.querySelector(sel);
const $all = sel => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts
    });
    if (!res.ok) {
        let msg = '';
        try { msg = await res.text(); } catch {}
        throw new Error(msg || `${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
}

// ========== Login ==========
async function initLogin() {
    const form = $('#loginForm');
    if (!form) return; // not on login page
    const errorEl = $('#errorMessage');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.textContent = '';

        const email = $('#email').value.trim();
        const password = $('#password').value;

        try {
            await api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
            window.location.href = 'userlist.html';
        } catch (_err) {
            errorEl.textContent = 'Invalid email or password.';
        }
    });
}

// ========== Dashboard ==========
async function initDashboard() {
    const usersTbody = $('#usersTbody');
    if (!usersTbody) return; // not on dashboard

    // Controls
    const searchBox = $('#searchBox');
    const withEmailCb = $('#withEmailCheckbox');
    const withoutEmailCb = $('#withoutEmailCheckbox');
    const resultInfo = $('#resultInfo');
    const pageIndicator = $('#pageIndicator');
    const prevBtn = $('#prevBtn');
    const nextBtn = $('#nextBtn');
    const logoutBtn = $('#logoutBtn');

    // Modals & forms
    const newUserBtn = $('#newUserBtn');
    const newUserModal = $('#newUserModal');
    const newUserForm = $('#newUserForm');
    const cancelNewUserBtn = $('#cancelNewUserBtn');
    const newErr = $('#newUserFormError');

    const editUserModal = $('#editUserModal');
    const editUserForm = $('#editUserForm');
    const cancelEditUserBtn = $('#cancelEditUserBtn');

    // Create selects
    const newProvince = $('#newProvince');
    const newCity = $('#newCity');
    const newBarangay = $('#newBarangay');
    const newDepartmentName = $('#newDepartmentName');

    // Edit selects
    const editProvince = $('#editProvince');
    const editCity = $('#editCity');
    const editBarangay = $('#editBarangay');
    const editDepartmentName = $('#editDepartmentName');

    // ---------- Departments ----------
    async function loadDepartments() {
        const { data } = await api('/items/department');
        const opts = ['<option value="">Select a department</option>']
            .concat((data || []).map(d => `<option value="${d.department_id}">${d.department_name}</option>`));
        if (newDepartmentName) newDepartmentName.innerHTML = opts.join('');
        if (editDepartmentName) editDepartmentName.innerHTML = opts.join('');
    }

    // ---------- LGU JSONs ----------
    let PROVINCE = [], CITY = [], BRGY = [];
    const provinceByCode = new Map();             // province_code -> province obj
    const provinceCodeByName = new Map();         // normalized province_name -> province_code
    const citiesByProvince = new Map();           // province_code -> city[]
    const brgysByCity = new Map();                // city_code -> brgy[]

    function getCityByName(province_code, city_name) {
        if (!province_code || !city_name) return null;
        const list = citiesByProvince.get(province_code) || [];
        const target = (city_name || '').trim().toLowerCase();
        return list.find(c => (c.city_name || '').trim().toLowerCase() === target) || null;
    }
    function getBrgyByName(city_code, brgy_name) {
        if (!city_code || !brgy_name) return null;
        const list = brgysByCity.get(city_code) || [];
        const target = (brgy_name || '').trim().toLowerCase();
        return list.find(b => (b.brgy_name || '').trim().toLowerCase() === target) || null;
    }

    async function loadLgu() {
        const [province, city, brgy] = await Promise.all([
            fetch('/data/province.json').then(r => r.json()),
            fetch('/data/city.json').then(r => r.json()),
            fetch('/data/barangay.json').then(r => r.json()),
        ]);

        PROVINCE = province || [];
        CITY = city || [];
        BRGY = brgy || [];

        for (const p of PROVINCE) {
            provinceByCode.set(p.province_code, p);
            const key = (p.province_name || '').trim().toLowerCase();
            if (key) provinceCodeByName.set(key, p.province_code);
        }
        for (const c of CITY) {
            const list = citiesByProvince.get(c.province_code) || [];
            list.push(c);
            citiesByProvince.set(c.province_code, list);
        }
        for (const b of BRGY) {
            const list = brgysByCity.get(b.city_code) || [];
            list.push(b);
            brgysByCity.set(b.city_code, list);
        }

        populateProvinces('new');
        populateProvinces('edit');
        bindCascades('new');
        bindCascades('edit');
    }

    function option(htmlValue, label) {
        return `<option value="${htmlValue}">${label}</option>`;
    }

    function populateProvinces(prefix) {
        const el = $(`#${prefix}Province`);
        if (!el) return;
        const opts = [option('', 'Select a province')]
            .concat(PROVINCE.map(p => option(p.province_code, p.province_name)));
        el.innerHTML = opts.join('');
        const cityEl = $(`#${prefix}City`);
        const brgyEl = $(`#${prefix}Barangay`);
        if (cityEl) cityEl.innerHTML = option('', 'Select a province first');
        if (brgyEl) brgyEl.innerHTML = option('', 'Select a city first');
    }

    function populateCities(prefix, provinceCode) {
        const el = $(`#${prefix}City`);
        const brgyEl = $(`#${prefix}Barangay`);
        if (!el) return;
        if (!provinceCode) {
            el.innerHTML = option('', 'Select a province first');
            if (brgyEl) brgyEl.innerHTML = option('', 'Select a city first');
            return;
        }
        const cities = citiesByProvince.get(provinceCode) || [];
        const opts = [option('', 'Select a city/municipality')]
            .concat(cities.map(c => option(c.city_code, c.city_name)));
        el.innerHTML = opts.join('');
        if (brgyEl) brgyEl.innerHTML = option('', 'Select a city first');
    }

    function populateBarangays(prefix, cityCode) {
        const el = $(`#${prefix}Barangay`);
        if (!el) return;
        if (!cityCode) {
            el.innerHTML = option('', 'Select a city first');
            return;
        }
        const barangays = brgysByCity.get(cityCode) || [];
        const opts = [option('', 'Select a barangay')]
            .concat(barangays.map(b => option(b.brgy_code, b.brgy_name)));
        el.innerHTML = opts.join('');
    }

    function bindCascades(prefix) {
        const provinceEl = $(`#${prefix}Province`);
        const cityEl = $(`#${prefix}City`);
        const brgyEl = $(`#${prefix}Barangay`);

        provinceEl?.addEventListener('change', () => {
            populateCities(prefix, provinceEl.value);
            if (brgyEl) brgyEl.innerHTML = option('', 'Select a city first');
        });

        cityEl?.addEventListener('change', () => {
            populateBarangays(prefix, cityEl.value);
        });
    }

    // ---------- Users ----------
    let ALL_USERS = [];
    const PAGE_SIZE = 15;
    let currentPage = 1;

    async function loadUsers() {
        try {
            const { data } = await api('/items/user');
            ALL_USERS = data || [];
            renderUsers();
        } catch (err) {
            console.error('Failed to load users', err);
            alert('Failed to load users: ' + err.message);
        }
    }

    function filterUsers() {
        const search = (searchBox.value || '').toLowerCase();
        const withEmail = withEmailCb.checked;
        const withoutEmail = withoutEmailCb.checked;

        return ALL_USERS.filter(u => {
            const hasEmail = !!u.user_email;
            if (withEmail && !withoutEmail && !hasEmail) return false;
            if (!withEmail && withoutEmail && hasEmail) return false;
            if (!withEmail && !withoutEmail) return false;

            if (search) {
                const name = `${u.user_fname || ''} ${u.user_mname || ''} ${u.user_lname || ''}`.toLowerCase();
                const dep = (u.user_department || '').toString();
                return name.includes(search) || (u.user_email || '').toLowerCase().includes(search) || dep.includes(search);
            }
            return true;
        });
    }

    function renderUsers() {
        const filtered = filterUsers();
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;

        const start = (currentPage - 1) * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, total);
        const pageItems = filtered.slice(start, end);

        usersTbody.innerHTML = pageItems.map(u => `
      <tr>
        <td class="fullname-cell" data-user-id="${u.user_id}">
          <div class="font-semibold">${u.user_fname || ''} ${u.user_lname || ''}</div>
          <div class="text-sm text-slate-500">${u.user_email || 'No email'}</div>
          <div class="text-xs text-slate-400">${[u.user_brgy, u.user_city, u.user_province].filter(Boolean).join(' • ') || ''}</div>
        </td>
        <td class="text-sm">${u.user_department || 'N/A'}</td>
        <td class="text-sm">
          ${u.user_position || 'N/A'}
          <a class="ml-2 text-blue-600 hover:underline" href="view_id.html?id=${encodeURIComponent(u.user_id)}" target="_blank">View ID</a>
        </td>
      </tr>
    `).join('');

        if (total === 0) {
            resultInfo.textContent = 'No users found';
            pageIndicator.textContent = '0 / 0';
            prevBtn.disabled = true;
            nextBtn.disabled = true;
        } else {
            resultInfo.textContent = `Showing ${start + 1}-${end} of ${total} users`;
            pageIndicator.textContent = `${currentPage} / ${totalPages}`;
            prevBtn.disabled = currentPage <= 1;
            nextBtn.disabled = currentPage >= totalPages;
        }

        $all('#usersTbody .fullname-cell').forEach(cell => {
            cell.addEventListener('click', () => {
                const user = ALL_USERS.find(u => u.user_id == cell.dataset.userId);
                if (user) showEditUserModal(user);
            });
        });
    }

    // ---------- Modal helpers ----------
    const backdrop = document.createElement('div');
    backdrop.className = 'fixed inset-0 bg-black bg-opacity-50 z-40 hidden';
    document.body.appendChild(backdrop);

    function showModal(modal) {
        modal.classList.remove('hidden');
        backdrop.classList.remove('hidden');
    }
    function closeModal(modal) {
        modal.classList.add('hidden');
        backdrop.classList.add('hidden');
    }
    backdrop.addEventListener('click', () => {
        if (!newUserModal.classList.contains('hidden')) closeModal(newUserModal);
        if (!editUserModal.classList.contains('hidden')) closeModal(editUserModal);
    });

    newUserBtn?.addEventListener('click', () => showModal(newUserModal));
    cancelNewUserBtn?.addEventListener('click', () => closeModal(newUserModal));
    cancelEditUserBtn?.addEventListener('click', () => closeModal(editUserModal));
    logoutBtn?.addEventListener('click', async () => {
        try { await api('/logout', { method: 'POST' }); } catch {}
        window.location.href = 'index.html';
    });

    // Tabs (future-proof)
    const tabButtons = $all('#editUserModal .tab-button');
    const tabContents = $all('#editUserModal .tab-content');
    function activateTab(id) {
        tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === id));
        tabContents.forEach(tc => tc.classList.toggle('hidden', tc.id !== id));
    }
    tabButtons.forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

    // Sub-tabs (if any)
    const subtabButtons = $all('#editUserModal .subtab-button');
    const subtabContents = $all('#editUserModal .sub-tab-content');
    function activateSubtab(id) {
        subtabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.subtab === id));
        subtabContents.forEach(tc => tc.classList.toggle('hidden', tc.id !== id));
    }
    subtabButtons.forEach(btn => btn.addEventListener('click', () => activateSubtab(btn.dataset.subtab)));

    // ---------- Create User ----------
    newUserForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        newErr.textContent = '';
        const fd = new FormData(newUserForm);

        const pCode = fd.get('province') || '';
        const cCode = fd.get('city') || '';
        const bCode = fd.get('barangay') || '';

        const pName = (provinceByCode.get(pCode)?.province_name) || null;
        const cName = (citiesByProvince.get(pCode) || []).find(c => c.city_code === cCode)?.city_name || null;
        const bName = (brgysByCity.get(cCode) || []).find(b => b.brgy_code === bCode)?.brgy_name || null;

        const body = {
            user_fname: fd.get('firstName') || null,
            user_mname: fd.get('middleName') || null,
            user_lname: fd.get('lastName') || null,
            user_contact: fd.get('contact') || null,
            user_bday: fd.get('birthday') || null,
            user_province: pName,
            user_city: cName,
            user_brgy: bName,
            user_department: parseInt(fd.get('department'), 10) || null,
            user_position: fd.get('designation') || null,
            user_email: fd.get('email') || null,
            user_password: fd.get('password') || null, // plaintext per your flow
            user_tin: fd.get('tin') || null,
            user_sss: fd.get('sss') || null,
            user_philhealth: fd.get('philhealth') || null,
            user_pagibig: fd.get('pagibig') || null,
            user_dateOfHire: fd.get('dateOfHire') || null,
            rf_id: fd.get('rf_id') || null,
            isAdmin: !!fd.get('isAdmin'),
            emergency_contact_name: fd.get('emergency_contact_name') || null,
            emergency_contact_number: fd.get('emergency_contact_number') || null,
        };

        try {
            await api('/items/user', { method: 'POST', body: JSON.stringify(body) });
            closeModal(newUserModal);
            newUserForm.reset();
            populateProvinces('new'); // reset cascades
            await loadUsers();
        } catch (err) {
            newErr.textContent = `Creation failed: ${err.message}`;
        }
    });

    // ---------- Edit User ----------
    function showEditUserModal(user) {
        editUserForm.dataset.userId = user.user_id;

        $('#editFirstName').value = user.user_fname || '';
        $('#editMiddleName').value = user.user_mname || '';
        $('#editLastName').value = user.user_lname || '';
        $('#editContact').value = user.user_contact || '';
        $('#editBirthday').value = user.user_bday ? String(user.user_bday).split(' ')[0] : '';

        // Province name -> code
        const pCode = provinceCodeByName.get((user.user_province || '').trim().toLowerCase()) || '';
        editProvince.value = pCode || '';
        populateCities('edit', pCode);

        // City name -> code
        let cCode = '';
        if (pCode && user.user_city) {
            const city = getCityByName(pCode, user.user_city);
            cCode = city?.city_code || '';
        }
        editCity.value = cCode || '';
        populateBarangays('edit', cCode);

        // Barangay name -> code
        let bCode = '';
        if (cCode && user.user_brgy) {
            const brgy = getBrgyByName(cCode, user.user_brgy);
            bCode = brgy?.brgy_code || '';
        }
        editBarangay.value = bCode || '';

        if (editDepartmentName) editDepartmentName.value = user.user_department || '';
        $('#editDesignation').value = user.user_position || '';
        $('#editEmail').value = user.user_email || '';
        const editPwdEl = $('#editPassword');
        if (editPwdEl) editPwdEl.value = ''; // keep empty unless changing
        $('#editDateOfHire').value = user.user_dateOfHire ? String(user.user_dateOfHire).split(' ')[0] : '';
        $('#editRfId').value = user.rf_id || '';
        $('#editTin').value = user.user_tin || '';
        $('#editSSS').value = user.user_sss || '';
        $('#editPhilhealth').value = user.user_philhealth || '';
        $('#editPagibig').value = user.user_pagibig || '';
        $('#editIsAdmin').checked = !!user.isAdmin;

        // Emergency contacts if present in form
        const eName = $('#editEmergencyName');
        const ePhone = $('#editEmergencyPhone');
        if (eName) eName.value = user.emergency_contact_name || '';
        if (ePhone) ePhone.value = user.emergency_contact_number || '';

        showModal(editUserModal);
    }

    editUserForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userId = editUserForm.dataset.userId;
        if (!userId) return;

        const fd = new FormData(editUserForm);

        const pCode = fd.get('province') || '';
        const cCode = fd.get('city') || '';
        const bCode = fd.get('barangay') || '';

        const body = {
            user_fname: fd.get('firstName') || null,
            user_mname: fd.get('middleName') || null,
            user_lname: fd.get('lastName') || null,
            user_contact: fd.get('contact') || null,
            user_bday: fd.get('birthday') || null,
            user_department: parseInt(fd.get('department'), 10) || null,
            user_position: fd.get('designation') || null,
            user_email: fd.get('email') || null,
            ...(fd.get('password') ? { user_password: fd.get('password') } : {}),
            user_dateOfHire: fd.get('dateOfHire') || null,
            rf_id: fd.get('rf_id') || null,
            user_tin: fd.get('tin') || null,
            user_sss: fd.get('sss') || null,
            user_philhealth: fd.get('philhealth') || null,
            user_pagibig: fd.get('pagibig') || null,
            isAdmin: !!fd.get('isAdmin'),
            emergency_contact_name: fd.get('emergency_contact_name') || null,
            emergency_contact_number: fd.get('emergency_contact_number') || null,
        };

        // Only include address fields IF a selection was made
        if (pCode) {
            const pName = (provinceByCode.get(pCode)?.province_name) || null;
            body.user_province = pName;
        }
        if (cCode) {
            const cName = (citiesByProvince.get(pCode) || []).find(c => c.city_code === cCode)?.city_name || null;
            body.user_city = cName;
        }
        if (bCode) {
            const bName = (brgysByCity.get(cCode) || []).find(b => b.brgy_code === bCode)?.brgy_name || null;
            body.user_brgy = bName;
        }

        // Remove undefined keys
        Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

        try {
            await api(`/items/user/${userId}`, { method: 'PATCH', body: JSON.stringify(body) });
            closeModal(editUserModal);
            await loadUsers();
        } catch (err) {
            alert(`Update user failed: ${err.message}`);
        }
    });

    // ---------- Wire up paging & filters ----------
    prevBtn?.addEventListener('click', () => { currentPage--; renderUsers(); });
    nextBtn?.addEventListener('click', () => { currentPage++; renderUsers(); });
    searchBox?.addEventListener('input', () => { currentPage = 1; renderUsers(); });
    withEmailCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });
    withoutEmailCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });

    // ---------- Boot ----------
    await Promise.all([loadDepartments(), loadLgu()]);
    await loadUsers();
}

// ---------- Entrypoint ----------
document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initDashboard();
});
