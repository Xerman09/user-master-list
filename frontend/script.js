// frontend/script.js
// Works for both index.html (login) and userlist.html (dashboard)

const API_BASE = ''; // same-origin

/* ---------- CONFIG ---------- */
const FILE_HOST = 'http://192.168.1.154';

/* ---------- Tiny DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
const getEl = (id) => document.getElementById(id);
const setVal = (id, v = '') => { const el = getEl(id); if (el) el.value = v ?? ''; };
const setChecked = (id, b) => { const el = getEl(id); if (el) el.checked = !!b; };
const setSelect = (id, v) => { const el = getEl(id); if (el) el.value = (v ?? ''); };

/* ---------- API helper ---------- */
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

/* ---------- Media path normalizer ---------- */
function normalizeMediaUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u) || u.startsWith('/uploads/')) return u;
    if (FILE_HOST && (u.startsWith('\\\\') || u.startsWith('//') || u.startsWith('file://'))) {
        const cleaned = u.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^\/+/, '');
        return `${FILE_HOST}/${cleaned}`;
    }
    return null;
}

/* ---------- Upload helpers ---------- */
async function uploadFile(inputId, route) {
    const input = getEl(inputId);
    if (!input || !input.files || !input.files[0]) return null;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    try {
        const res = await fetch(route, { method: 'POST', body: fd, credentials: 'include' });
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        return json.url || null;
    } catch (e) {
        console.warn(`Upload failed for ${route}:`, e.message || e);
        return null;
    }
}

function wireImagePicker(inputId, previewImgId) {
    const input = getEl(inputId), preview = getEl(previewImgId);
    if (!input || !preview) return;
    input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { preview.src = r.result; preview.classList.remove('hidden'); };
        r.readAsDataURL(f);
    });
}

/* ---------- Signature Pad ---------- */
function makeSignaturePad(canvasId, clearBtnId) {
    const canvas = getEl(canvasId);
    if (!canvas) return null;

    canvas.style.touchAction = 'none';
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let hasInk = false;

    function resizeBackingStore() {
        const cssW = canvas.clientWidth || 600;
        const cssH = canvas.clientHeight || 180;
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        canvas.width  = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBaseline(cssW, cssH);
        hasInk = false;
    }

    function drawBaseline(cssW, cssH) {
        ctx.save();
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const y = cssH - 20;
        ctx.moveTo(8, y);
        ctx.lineTo(cssW - 8, y);
        ctx.stroke();
        ctx.restore();
    }

    const pos = (e) => ({ x: e.offsetX, y: e.offsetY });

    let drawing = false, last = null;
    canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drawing = true; last = pos(e);
    });
    canvas.addEventListener('pointermove', e => {
        if (!drawing) return;
        const p = pos(e);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
        hasInk = true;
    });
    const stop = () => { drawing = false; last = null; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointerleave', stop);
    canvas.addEventListener('pointercancel', stop);

    const clearBtn = getEl(clearBtnId);
    if (clearBtn) clearBtn.addEventListener('click', () => resizeBackingStore());

    const init = () => resizeBackingStore();
    setTimeout(init, 0);
    window.addEventListener('resize', init);

    return {
        clear: init,
        hasInk: () => hasInk,
        toDataURL: () => canvas.toDataURL('image/png')
    };
}

/* ---------- Login ---------- */
async function initLogin() {
    const form = $('#loginForm');
    if (!form) return;
    const errorEl = $('#errorMessage');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        const email = $('#email').value.trim();
        const password = $('#password').value;

        try {
            await api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
            window.location.href = 'userlist.html';
        } catch {
            errorEl.textContent = 'Invalid email or password.';
        }
    });
}

/* ---------- Dashboard ---------- */
async function initDashboard() {
    const usersTbody = $('#usersTbody');
    if (!usersTbody) return;

    // Controls
    const searchBox = $('#searchBox');
    const withEmailCb = $('#withEmailCheckbox');
    const withoutEmailCb = $('#withoutEmailCheckbox');

    // NEW: status checkboxes
    const showActiveCb = $('#showActiveCheckbox');
    const showInactiveCb = $('#showInactiveCheckbox');

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

    // File inputs / previews
    wireImagePicker('newUserImage', 'newUserImagePreview');
    wireImagePicker('editUserImage', 'editUserImagePreview');
    wireImagePicker('newSignatureFile', 'newSignaturePreview');
    wireImagePicker('editSignatureFile', 'editSignaturePreview');

    // Signature pads
    const newSigPad  = makeSignaturePad('newSignatureCanvas',  'newSignatureClear');
    const editSigPad = makeSignaturePad('editSignatureCanvas', 'editSignatureClear');

    // Selects
    const newDepartmentName = $('#newDepartmentName');
    const editDepartmentName = $('#editDepartmentName');

    // LGU caches
    const citiesByProvince = new Map();
    const brgysByCity = new Map();

    async function loadDepartments() {
        const { data } = await api('/items/department');
        const opts = ['<option value="">Select a department</option>']
            .concat((data || []).map(d => `<option value="${d.department_id}">${d.department_name}</option>`));
        if (newDepartmentName)  newDepartmentName.innerHTML  = opts.join('');
        if (editDepartmentName) editDepartmentName.innerHTML = opts.join('');
    }

    async function loadLgu() {
        const [province, city, brgy] = await Promise.all([
            fetch('/data/province.json').then(r => r.json()),
            fetch('/data/city.json').then(r => r.json()),
            fetch('/data/barangay.json').then(r => r.json()),
        ]);

        function option(val, label){ return `<option value="${val}">${label}</option>`; }

        function populateProvinces(prefix, list) {
            const el = getEl(`${prefix}Province`);
            const cEl = getEl(`${prefix}City`);
            const bEl = getEl(`${prefix}Barangay`);
            if (!el) return;
            el.innerHTML = ['<option value="">Select a province</option>']
                .concat((list || []).map(p => `<option value="${p.province_code}">${p.province_name}</option>`)).join('');
            if (cEl) cEl.innerHTML = '<option value="">Select a province first</option>';
            if (bEl) bEl.innerHTML = '<option value="">Select a city first</option>';
        }

        (city || []).forEach(c => {
            const list = citiesByProvince.get(c.province_code) || [];
            list.push(c); citiesByProvince.set(c.province_code, list);
        });

        (brgy || []).forEach(b => {
            const list = brgysByCity.get(b.city_code) || [];
            list.push(b); brgysByCity.set(b.city_code, list);
        });

        populateProvinces('new', province || []);
        populateProvinces('edit', province || []);
        bindCascades('new');
        bindCascades('edit');
    }

    function option(val, label){ return `<option value="${val}">${label}</option>`; }
    function populateCities(prefix, provinceCode) {
        const el = getEl(`${prefix}City`);
        const bEl = getEl(`${prefix}Barangay`);
        if (!el) return;
        if (!provinceCode) {
            el.innerHTML = option('', 'Select a province first');
            if (bEl) bEl.innerHTML = option('', 'Select a city first');
            return;
        }
        const cities = (citiesByProvince.get(provinceCode) || []);
        el.innerHTML = [option('', 'Select a city/municipality')]
            .concat(cities.map(c => option(c.city_code, c.city_name))).join('');
        if (bEl) bEl.innerHTML = option('', 'Select a city first');
    }
    function populateBarangays(prefix, cityCode) {
        const el = getEl(`${prefix}Barangay`);
        if (!el) return;
        if (!cityCode) { el.innerHTML = option('', 'Select a city first'); return; }
        const brgys = (brgysByCity.get(cityCode) || []);
        el.innerHTML = [option('', 'Select a barangay')]
            .concat(brgys.map(b => option(b.brgy_code, b.brgy_name))).join('');
    }
    function bindCascades(prefix) {
        const p = getEl(`${prefix}Province`);
        const c = getEl(`${prefix}City`);
        const b = getEl(`${prefix}Barangay`);
        p?.addEventListener('change', () => { populateCities(prefix, p.value); if (b) b.innerHTML = option('', 'Select a city first'); });
        c?.addEventListener('change', () => { populateBarangays(prefix, c.value); });
    }

    /* ---------- Users ---------- */
    let ALL_USERS = [];
    const PAGE_SIZE = 15;
    let currentPage = 1;

    async function loadUsers() {
        const { data } = await api('/items/user');
        // Normalize any legacy media URLs so browser won't try file://
        ALL_USERS = (data || []).map(u => ({
            ...u,
            user_image: normalizeMediaUrl(u.user_image),
            signature: normalizeMediaUrl(u.signature),
            // If backend didn't send isDeleted for some reason, assume active (false)
            isDeleted: typeof u.isDeleted === 'boolean' ? u.isDeleted : false,
        }));
        renderUsers();
    }

    function filterUsers() {
        const search = (searchBox.value || '').toLowerCase();

        // Email filters
        const withEmail    = withEmailCb.checked;
        const withoutEmail = withoutEmailCb.checked;

        // Status filters
        const showActive   = showActiveCb?.checked ?? true;
        const showInactive = showInactiveCb?.checked ?? true;

        return ALL_USERS.filter(u => {
            // --- status (active vs inactive) ---
            const isInactive = !!u.isDeleted;
            const isActive   = !isInactive;

            if (showActive && !showInactive && !isActive)   return false;
            if (!showActive && showInactive && !isInactive) return false;
            if (!showActive && !showInactive)               return false;

            // --- email filters ---
            const hasEmail = !!u.user_email;
            if (withEmail && !withoutEmail && !hasEmail) return false;
            if (!withEmail && withoutEmail && hasEmail) return false;
            if (!withEmail && !withoutEmail) return false;

            // --- search ---
            if (search) {
                const name = `${u.user_fname || ''} ${u.user_mname || ''} ${u.user_lname || ''}`.toLowerCase();
                const dep  = (u.user_department || '').toString();
                return (
                    name.includes(search) ||
                    (u.user_email || '').toLowerCase().includes(search) ||
                    dep.includes(search)
                );
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
          <div class="font-semibold">
            ${u.user_fname || ''} ${u.user_lname || ''}
            ${u.isDeleted ? '<span class="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700">Inactive</span>' : ''}
          </div>
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

    /* ---------- Modal helpers ---------- */
    const backdrop = document.createElement('div');
    backdrop.className = 'fixed inset-0 bg-black bg-opacity-50 z-40 hidden';
    document.body.appendChild(backdrop);

    function showModal(modal) { modal.classList.remove('hidden'); backdrop.classList.remove('hidden'); }
    function closeModal(modal){ modal.classList.add('hidden'); backdrop.classList.add('hidden'); }
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

    /* ---------- Create User ---------- */
    newUserForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        newErr.textContent = '';
        const fd = new FormData(newUserForm);

        const pCode = fd.get('province') || '';
        const cCode = fd.get('city') || '';
        const bCode = fd.get('barangay') || '';

        const pName = pCode ? ($('#newProvince option:checked')?.textContent || null) : null;
        const cName = cCode ? ($('#newCity option:checked')?.textContent || null) : null;
        const bName = bCode ? ($('#newBarangay option:checked')?.textContent || null) : null;

        let userImageUrl = await uploadFile('newUserImage', '/uploads/users');
        let signatureUrl = await uploadFile('newSignatureFile', '/uploads/signatures');

        if (!signatureUrl && newSigPad?.hasInk()) {
            try {
                const r = await api('/signatures', { method:'POST', body: JSON.stringify({ dataUrl: newSigPad.toDataURL() }) });
                signatureUrl = r.url || null;
            } catch {}
        }

        const body = {
            user_fname: fd.get('firstName') || null,
            user_mname: fd.get('middleName') || null,
            user_lname: fd.get('lastName') || null,
            user_contact: fd.get('contact') || null,
            user_bday: fd.get('birthday') || null,
            user_province: pName, user_city: cName, user_brgy: bName,
            user_department: parseInt(fd.get('department'), 10) || null,
            user_position: fd.get('designation') || null,
            user_email: fd.get('email') || null,
            user_password: fd.get('password') || null,
            user_tin: fd.get('tin') || null,
            user_sss: fd.get('sss') || null,
            user_philhealth: fd.get('philhealth') || null,
            user_pagibig: fd.get('pagibig') || null,
            user_dateOfHire: fd.get('dateOfHire') || null,
            rf_id: fd.get('rf_id') || null,
            isAdmin: !!fd.get('isAdmin'),
            emergency_contact_name: fd.get('emergency_contact_name') || null,
            emergency_contact_number: fd.get('emergency_contact_number') || null,
            ...(userImageUrl ? { user_image: userImageUrl } : {}),
            ...(signatureUrl ? { signature: signatureUrl } : {}),
        };

        try {
            await api('/items/user', { method:'POST', body: JSON.stringify(body) });
            const sf = getEl('newSignatureFile'); if (sf) sf.value = '';
            const sp = getEl('newSignaturePreview'); if (sp) { sp.src = ''; sp.classList.add('hidden'); }
            if (newSigPad) newSigPad.clear();
            const uf = getEl('newUserImage'); if (uf) uf.value = '';
            const up = getEl('newUserImagePreview'); if (up) { up.src = ''; up.classList.add('hidden'); }
            newUserForm.reset();
            closeModal(newUserModal);
            await loadUsers();
        } catch (err) {
            newErr.textContent = `Creation failed: ${err.message}`;
        }
    });

    /* ---------- Edit User ---------- */
    function showEditUserModal(user) {
        setVal('editFirstName', user.user_fname || '');
        setVal('editMiddleName', user.user_mname || '');
        setVal('editLastName', user.user_lname || '');
        setVal('editContact', user.user_contact || '');
        setVal('editBirthday', user.user_bday ? String(user.user_bday).split(' ')[0] : '');

        const pSel = getEl('editProvince');
        const cSel = getEl('editCity');
        const bSel = getEl('editBarangay');

        if (pSel) {
            const pTxt = (user.user_province || '').trim().toLowerCase();
            let pVal = '';
            if (pTxt) {
                const idx = Array.from(pSel.options).findIndex(o => (o.textContent || '').trim().toLowerCase() === pTxt);
                if (idx >= 0) pVal = pSel.options[idx].value;
            }
            pSel.value = pVal || '';
            populateCities('edit', pSel.value);

            if (cSel) {
                const cTxt = (user.user_city || '').trim().toLowerCase();
                let cVal = '';
                if (cTxt) {
                    const idx = Array.from(cSel.options).findIndex(o => (o.textContent || '').trim().toLowerCase() === cTxt);
                    if (idx >= 0) cVal = cSel.options[idx].value;
                }
                cSel.value = cVal || '';
                populateBarangays('edit', cSel.value);

                if (bSel) {
                    const bTxt = (user.user_brgy || '').trim().toLowerCase();
                    let bVal = '';
                    if (bTxt) {
                        const idx = Array.from(bSel.options).findIndex(o => (o.textContent || '').trim().toLowerCase() === bTxt);
                        if (idx >= 0) bVal = bSel.options[idx].value;
                    }
                    bSel.value = bVal || '';
                }
            }
        }

        setSelect('editDepartmentName', user.user_department || '');
        setVal('editDesignation', user.user_position || '');
        setVal('editEmail', user.user_email || '');
        const pw = getEl('editPassword'); if (pw) pw.value = '';
        setVal('editDateOfHire', user.user_dateOfHire ? String(user.user_dateOfHire).split(' ')[0] : '');
        setVal('editRfId', user.rf_id || '');
        setVal('editTin', user.user_tin || '');
        setVal('editSSS', user.user_sss || '');
        setVal('editPhilhealth', user.user_philhealth || '');
        setVal('editPagibig', user.user_pagibig || '');
        setChecked('editIsAdmin', !!user.isAdmin);

        // FIX: now always present (backend guarantees), but default-safe anyway
        setChecked('editIsDelete', !!user.isDeleted);

        setVal('editEmergencyName', user.emergency_contact_name || '');
        setVal('editEmergencyPhone', user.emergency_contact_number || '');

        const imgPrev = getEl('editUserImagePreview');
        const normalizedImg = normalizeMediaUrl(user.user_image);
        if (imgPrev) {
            if (normalizedImg) { imgPrev.src = normalizedImg; imgPrev.classList.remove('hidden'); }
            else { imgPrev.src = ''; imgPrev.classList.add('hidden'); }
        }
        const sigPrev = getEl('editSignaturePreview');
        const normalizedSig = normalizeMediaUrl(user.signature);
        if (sigPrev) {
            if (normalizedSig) { sigPrev.src = normalizedSig; sigPrev.classList.remove('hidden'); }
            else { sigPrev.src = ''; sigPrev.classList.add('hidden'); }
        }
        if (editSigPad) editSigPad.clear();

        if (editUserForm) editUserForm.dataset.userId = user.user_id;
        showModal(editUserModal);
    }

    const nonEmpty = (v) => (v !== undefined && v !== null && String(v).trim() !== '');

    editUserForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userId = editUserForm?.dataset?.userId;
        if (!userId) return;

        const fd = new FormData(editUserForm);
        const pCode = fd.get('province') || '';
        const cCode = fd.get('city') || '';
        const bCode = fd.get('barangay') || '';

        let newImageUrl = await uploadFile('editUserImage', '/uploads/users');
        let newSignatureUrl = await uploadFile('editSignatureFile', '/uploads/signatures');

        if (!newSignatureUrl && editSigPad?.hasInk()) {
            try {
                const r = await api('/signatures', { method:'POST', body: JSON.stringify({ dataUrl: editSigPad.toDataURL() }) });
                newSignatureUrl = r.url || null;
            } catch {}
        }

        const body = {};
        if (nonEmpty(fd.get('firstName'))) body.user_fname = fd.get('firstName');
        if (nonEmpty(fd.get('middleName'))) body.user_mname = fd.get('middleName');
        if (nonEmpty(fd.get('lastName')))  body.user_lname = fd.get('lastName');
        if (nonEmpty(fd.get('contact')))   body.user_contact = fd.get('contact');
        if (nonEmpty(fd.get('birthday')))  body.user_bday = fd.get('birthday');

        if (pCode) body.user_province = $('#editProvince option:checked')?.textContent || null;
        if (cCode) body.user_city     = $('#editCity option:checked')?.textContent || null;
        if (bCode) body.user_brgy     = $('#editBarangay option:checked')?.textContent || null;

        const dep = fd.get('department');
        if (nonEmpty(dep)) body.user_department = parseInt(dep, 10);
        if (nonEmpty(fd.get('designation'))) body.user_position = fd.get('designation');
        if (nonEmpty(fd.get('email')))       body.user_email = fd.get('email');
        if (nonEmpty(fd.get('password')))    body.user_password = fd.get('password');
        if (nonEmpty(fd.get('dateOfHire')))  body.user_dateOfHire = fd.get('dateOfHire');
        if (nonEmpty(fd.get('rf_id')))       body.rf_id = fd.get('rf_id');
        if (nonEmpty(fd.get('tin')))         body.user_tin = fd.get('tin');
        if (nonEmpty(fd.get('sss')))         body.user_sss = fd.get('sss');
        if (nonEmpty(fd.get('philhealth')))  body.user_philhealth = fd.get('philhealth');
        if (nonEmpty(fd.get('pagibig')))     body.user_pagibig = fd.get('pagibig');

        body.isAdmin = !!fd.get('isAdmin');

        // Inactive toggle → backend maps to is_deleted
        const editInactiveChecked = getEl('editIsDelete')?.checked ?? false;
        body.isDeleted = !!editInactiveChecked;

        if (newImageUrl)     body.user_image = newImageUrl;
        if (newSignatureUrl) body.signature  = newSignatureUrl;

        try {
            await api(`/items/user/${userId}`, { method:'PATCH', body: JSON.stringify(body) });

            const sf = getEl('editSignatureFile'); if (sf) sf.value = '';
            const sp = getEl('editSignaturePreview'); if (sp) { sp.src = ''; sp.classList.add('hidden'); }
            if (editSigPad) editSigPad.clear();
            const uf = getEl('editUserImage'); if (uf) uf.value = '';
            const up = getEl('editUserImagePreview'); if (up) { up.src = ''; up.classList.add('hidden'); }

            closeModal(editUserModal);
            await loadUsers();
        } catch (err) {
            alert(`Update user failed: ${err.message}`);
        }
    });

    /* ---------- Paging/filters ---------- */
    prevBtn?.addEventListener('click', () => { currentPage--; renderUsers(); });
    nextBtn?.addEventListener('click', () => { currentPage++; renderUsers(); });
    searchBox?.addEventListener('input', () => { currentPage = 1; renderUsers(); });
    withEmailCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });
    withoutEmailCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });
    showActiveCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });
    showInactiveCb?.addEventListener('change', () => { currentPage = 1; renderUsers(); });

    /* ---------- Boot ---------- */
    await Promise.all([loadDepartments(), loadLgu()]);
    await loadUsers();
}

/* ---------- Entrypoint ---------- */
document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initDashboard();
});
