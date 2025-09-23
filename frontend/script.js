document.addEventListener('DOMContentLoaded', () => {
    // If opened via local static servers (e.gc., 63342, 63343, etc.), redirect to backend origin (3002) to avoid CORS and allow cookies
    const isLocalHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1';
    if (isLocalHost(window.location.hostname) && window.location.port && window.location.port !== '3002') {
        const file = window.location.pathname.split('/').pop() || 'index.html';
        const query = window.location.search || '';
        const hash = window.location.hash || '';
        window.location.href = `http://localhost:3002/${file}${query}${hash}`;
        return;
    }
    // API endpoints: same-origin if already on backend, otherwise target backend at localhost:3002 (for file:// fallback)
    const isFileProtocol = window.location.protocol === 'file:';
    const API_BASE = (window.location.port === '3002' && isLocalHost(window.location.hostname)) ? '' : (isFileProtocol ? 'http://localhost:3002' : '');
    const USERS_API_URL = `${API_BASE}/api/users`;
    const DEPARTMENTS_API_URL = `${API_BASE}/api/departments`;
    const LOGIN_URL = `${API_BASE}/api/login`;
    const AUTH_CURRENT_URL = `${API_BASE}/api/auth/current-login`;

    // --- Expose helpers needed by JavaFX WebView injector ---
    const attemptLogin = async (email, password) => {
        try {
            console.log('[SPA] Attempting login to', LOGIN_URL);
            const r = await fetch(LOGIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email, password })
            });
            const data = await r.json().catch(() => ({}));
            console.log('[SPA] /api/login status', r.status, data);
            if (r.ok && (data?.ok === true || data?.user)) {
                sessionStorage.setItem('isLoggedIn', 'true');
                window.location.href = 'userlist.html';
                return true;
            }
            return false;
        } catch (e) {
            console.error('[SPA] Login error', e);
            return false;
        }
    };

    const fetchCurrentLogin = async (force = false) => {
        try {
            const r = await fetch(AUTH_CURRENT_URL, { credentials: 'include' });
            const data = await r.json().catch(() => ({}));
            console.log('[SPA] current-login status', r.status, data);
            if (r.ok && (data?.ok === true || data?.user)) {
                sessionStorage.setItem('isLoggedIn', 'true');
                if (document.getElementById('loginForm')) {
                    window.location.href = 'userlist.html';
                }
                return data;
            }
        } catch (e) {
            console.warn('[SPA] current-login failed', e);
        }
        return null;
    };

    window.fetchCurrentLogin = fetchCurrentLogin;
    window.autoLogin = (email, password) => attemptLogin(email, password);

    window.addEventListener('VOS_FETCH_CURRENT_LOGIN', () => fetchCurrentLogin(true));
    window.addEventListener('VOS_CREDENTIALS', (e) => {
        try {
            const detail = e?.detail || {};
            const email = detail.email || detail.username || detail.user_email;
            const password = detail.password || detail.user_password;
            const form = document.getElementById('loginForm');
            if (form) {
                if (email) form.email.value = email;
                if (password) form.password.value = password;
            }
            if (email && password) attemptLogin(email, password);
        } catch (_) {}
    });

    /**
     * Handles logic for the LOGIN PAGE (index.html)
     */
    const handleLoginPage = () => {
        const loginForm = document.getElementById('loginForm');
        const errorMessage = document.getElementById('errorMessage');

        if (!loginForm) return;

        fetchCurrentLogin(true);

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (errorMessage) errorMessage.textContent = '';
            const email = loginForm.email.value;
            const password = loginForm.password.value;
            const ok = await attemptLogin(email, password);
            if (!ok) {
                if (errorMessage) errorMessage.textContent = 'Invalid email or password.';
            }
        });
    };

    /**
     * Handles logic for the USER LIST PAGE (userlist.html)
     */
    const handleUserListPage = () => {
        const usersTbody = document.getElementById('usersTbody');
        if (!usersTbody) return;

        if (sessionStorage.getItem('isLoggedIn') !== 'true') {
            window.location.href = 'index.html';
            return;
        }

        let allUsers = [];
        let allProvinces = [];
        let allCities = [];
        let allBarangays = [];
        let usersLoaded = false;
        let searchTerm = '';
        let currentPage = 1;
        let pageSize = 10;
        let showWithEmail = true;
        let showWithoutEmail = true;

        const searchBox = document.getElementById('searchBox');
        const pageSizeSelect = document.getElementById('pageSize');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const pageIndicator = document.getElementById('pageIndicator');
        const resultInfo = document.getElementById('resultInfo');
        const logoutBtn = document.getElementById('logoutBtn');
        const withEmailCheckbox = document.getElementById('withEmailCheckbox');
        const withoutEmailCheckbox = document.getElementById('withoutEmailCheckbox');
        const newUserModal = document.getElementById('newUserModal');
        const newUserForm = document.getElementById('newUserForm');
        const cancelNewUserBtn = document.getElementById('cancelNewUserBtn');
        const newUserFormError = document.getElementById('newUserFormError');
        const editUserModal = document.getElementById('editUserModal');
        const editUserForm = document.getElementById('editUserForm');
        const cancelEditUserBtn = document.getElementById('cancelEditUserBtn');
        const editUserFormError = document.getElementById('editUserFormError');
        const newUserBtn = document.getElementById('newUserBtn');

        withEmailCheckbox.checked = true;
        withoutEmailCheckbox.checked = true;

        // --- Generic Field Error Helpers ---
        function ensureFieldErrorElement(inputEl) {
            if (!inputEl) return null;
            const next = inputEl.nextElementSibling;
            if (next && next.classList.contains('field-error')) return next;
            const p = document.createElement('p');
            p.className = 'field-error text-red-600 text-xs mt-1';
            inputEl.insertAdjacentElement('afterend', p);
            return p;
        }

        function markFieldError(inputEl, message) {
            if (!inputEl) return;
            inputEl.classList.add('border-red-500', 'focus:ring-red-500', 'focus:border-red-500');
            const errEl = ensureFieldErrorElement(inputEl);
            if (errEl) errEl.textContent = message || 'Invalid value';
            const onInput = () => clearFieldError(inputEl);
            inputEl.removeEventListener('input', onInput);
            inputEl.addEventListener('input', onInput, { once: true });
        }

        function clearFieldError(inputEl) {
            if (!inputEl) return;
            inputEl.classList.remove('border-red-500', 'focus:ring-red-500', 'focus:border-red-500');
            const next = inputEl.nextElementSibling;
            if (next && next.classList.contains('field-error')) next.remove();
        }

        // --- Helpers for New User Modal ---
        const getNewUserInputs = () => ({
            firstName: document.getElementById('newFirstName'),
            middleName: document.getElementById('newMiddleName'),
            lastName: document.getElementById('newLastName'),
            email: document.getElementById('newEmail'),
            contact: document.getElementById('newContact'),
            rfid: document.getElementById('newRfid'),
            password: document.getElementById('newPassword'),
            passwordConfirm: document.getElementById('newPasswordConfirm')
        });

        function clearAllNewUserFieldErrors() {
            const inputs = getNewUserInputs();
            Object.values(inputs).forEach(clearFieldError);
            const formError = document.getElementById('newUserFormError');
            if (formError) formError.textContent = '';
        }

        // --- Helpers for Edit User Modal ---
        const getEditUserInputs = () => ({
            firstName: document.getElementById('editFirstName'),
            middleName: document.getElementById('editMiddleName'),
            lastName: document.getElementById('editLastName'),
            email: document.getElementById('editEmail'),
            contact: document.getElementById('editContact'),
            rfid: document.getElementById('editRfid'),
            password: document.getElementById('editPassword'),
            passwordConfirm: document.getElementById('editPasswordConfirm')
        });

        function clearAllEditUserFieldErrors() {
            const inputs = getEditUserInputs();
            Object.values(inputs).forEach(clearFieldError);
            const formError = document.getElementById('editUserFormError');
            if (formError) formError.textContent = '';
        }

        function findDuplicatesInAllUsers({ email, rfId }, currentUserId = null) {
            const result = { email: false, rfId: false };
            const normEmail = (v) => String(v ?? '').trim().toLowerCase();
            const normRf = (v) => String(v ?? '').trim();
            if (email) {
                const e = normEmail(email);
                result.email = Array.isArray(allUsers) && allUsers.some(u => normEmail(u.email) === e && u.userId !== currentUserId);
            }
            if (rfId) {
                const r = normRf(rfId);
                result.rfId = Array.isArray(allUsers) && allUsers.some(u => normRf(u.rfId ?? u.rfid ?? u.rf_id) === r && u.userId !== currentUserId);
            }
            return result;
        }

        const renderTable = () => {
            const filteredUsers = allUsers.filter(user => {
                const searchMatch = (
                    user.fullName?.toLowerCase().includes(searchTerm) ||
                    user.email?.toLowerCase().includes(searchTerm) ||
                    user.departmentName?.toLowerCase().includes(searchTerm)
                );
                const hasEmail = user.email && user.email.trim() !== '';
                let emailMatch = false;
                if (showWithEmail && showWithoutEmail) emailMatch = true;
                else if (showWithEmail) emailMatch = hasEmail;
                else if (showWithoutEmail) emailMatch = !hasEmail;
                return searchMatch && emailMatch;
            });

            const totalResults = filteredUsers.length;
            const totalPages = Math.ceil(totalResults / pageSize) || 1;
            const start = (currentPage - 1) * pageSize;
            const end = start + pageSize;
            const paginatedUsers = filteredUsers.slice(start, end);

            usersTbody.innerHTML = '';
            if (paginatedUsers.length === 0) {
                usersTbody.innerHTML = `<tr><td colspan="4" class="text-center text-slate-500 py-4">No users found.</td></tr>`;
            } else {
                paginatedUsers.forEach((user, index) => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${start + index + 1}</td>
                        <td class="fullname-cell cursor-pointer text-blue-600 hover:underline">${user.fullName || 'N/A'}</td>
                        <td>${user.email || 'N/A'}</td>
                        <td>${user.departmentName || 'N/A'}</td>
                    `;
                    const fullnameCell = row.querySelector('.fullname-cell');
                    if (fullnameCell) {
                        fullnameCell.addEventListener('click', () => openEditModal(user));
                    }
                    usersTbody.appendChild(row);
                });
            }

            pageIndicator.textContent = `${currentPage} / ${totalPages}`;
            resultInfo.textContent = `Showing ${start + 1} to ${start + paginatedUsers.length} of ${totalResults} results.`;
            prevBtn.disabled = currentPage === 1;
            nextBtn.disabled = currentPage === totalPages;
        };

        const populateDepartmentsDropdown = async (selectElement) => {
            try {
                const response = await fetch(DEPARTMENTS_API_URL);
                if (!response.ok) throw new Error('Could not fetch departments.');
                const responseData = await response.json();
                let departments = [];
                if (Array.isArray(responseData)) departments = responseData;
                else if (responseData && Array.isArray(responseData.data)) departments = responseData.data;
                else if (responseData && Array.isArray(responseData.content)) departments = responseData.content;
                else throw new Error('Department data is not in a recognizable format.');
                selectElement.innerHTML = '<option value="">Select a Department</option>';
                departments.forEach(dept => {
                    const option = document.createElement('option');
                    const deptName = dept.departmentName || dept.name || '';
                    const normalizedId = (dept.departmentId ?? dept.id ?? dept.department_id ?? dept.dept_id);
                    if (normalizedId != null && normalizedId !== '') {
                        option.value = String(normalizedId);
                        option.dataset.deptId = String(normalizedId);
                    } else {
                        option.value = '';
                        option.dataset.deptId = '';
                    }
                    option.textContent = deptName;
                    selectElement.appendChild(option);
                });
            } catch (error) {
                console.error("Failed to populate departments:", error);
                selectElement.innerHTML = '<option value="">Error loading departments</option>';
            }
        };

        const setupModalTabs = (modalElement) => {
            const mainTabs = modalElement.querySelectorAll('.main-tab-button');
            const mainContents = modalElement.querySelectorAll('.main-tab-content');
            const subTabs = modalElement.querySelectorAll('.sub-tab-button');
            const subContents = modalElement.querySelectorAll('.sub-tab-content');

            mainTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    mainTabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const target = modalElement.querySelector(tab.dataset.tabTarget);
                    mainContents.forEach(c => c.classList.add('hidden'));
                    if(target) target.classList.remove('hidden');
                });
            });

            subTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    subTabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const target = modalElement.querySelector(tab.dataset.subtabTarget);
                    subContents.forEach(c => c.classList.add('hidden'));
                    if(target) target.classList.remove('hidden');
                });
            });
        };

        setupModalTabs(editUserModal);

        const openEditModal = (user) => {
            editUserForm.reset();
            clearAllEditUserFieldErrors();
            editUserFormError.textContent = '';

            // --- Populate Basic Info ---
            const hiddenIdInput = document.getElementById('editUserId');
            if (hiddenIdInput) hiddenIdInput.value = user.userId;

            const names = (user.fullName || '').split(' ');
            const firstName = names[0] || '';
            const lastName = names.length > 1 ? names[names.length - 1] : '';
            const middleName = names.length > 2 ? names.slice(1, -1).join(' ') : '';

            document.getElementById('editFirstName').value = firstName;
            document.getElementById('editMiddleName').value = middleName;
            document.getElementById('editLastName').value = lastName;

            document.getElementById('editEmail').value = user.email || '';
            document.getElementById('editContact').value = user.mobileNumber || '';
            document.getElementById('editPosition').value = user.position || '';
            document.getElementById('editRfid').value = user.rfId ?? user.rfid ?? '';
            document.getElementById('editIsActive').checked = user.isActive;

            // --- Populate HR Info ---
            document.getElementById('editBirthday').value = toYMD(user.birthday);
            document.getElementById('editDateHired').value = toYMD(user.dateOfHire);
            document.getElementById('editTin').value = user.tin || '';
            document.getElementById('editSss').value = user.sss || '';
            document.getElementById('editPhilhealth').value = user.philhealth || '';
            // --- Populate Additional Fields to mirror /api/users structure ---
            const editImageEl = document.getElementById('editImage'); if (editImageEl) editImageEl.value = user.image || '';
            const editExternalIdEl = document.getElementById('editExternalId'); if (editExternalIdEl) editExternalIdEl.value = user.externalId || '';
            const editRoleIdEl = document.getElementById('editRoleId'); if (editRoleIdEl) editRoleIdEl.value = (user.roleId ?? '');
            const editTagsEl = document.getElementById('editTags'); if (editTagsEl) editTagsEl.value = (user.tags ?? '');
            const editBranchIdEl = document.getElementById('editBranchId'); if (editBranchIdEl) editBranchIdEl.value = (user.branchId ?? '');
            const editBranchNameEl = document.getElementById('editBranchName'); if (editBranchNameEl) editBranchNameEl.value = (user.branchName ?? '');
            const editOperationIdEl = document.getElementById('editOperationId'); if (editOperationIdEl) editOperationIdEl.value = (user.operationId ?? '');

            // --- Populate Department Dropdown ---
            const departmentDropdown = document.getElementById('editDepartmentName');
            populateDepartmentsDropdown(departmentDropdown).then(() => {
                const targetDeptId = user.departmentId ?? user.department_id;

                if (targetDeptId != null) {
                    const optionExists = Array.from(departmentDropdown.options).some(opt => opt.value === String(targetDeptId));
                    if (optionExists) {
                        departmentDropdown.value = String(targetDeptId);
                        return; // Exit if ID match is successful
                    } else {
                        console.warn(`Department ID "${targetDeptId}" from user data not found in the department list. Falling back to name match.`);
                    }
                }

                // Fallback: If ID match fails or ID is null, try matching by name
                const targetDeptName = (user.departmentName || user.department || '').trim();
                if (targetDeptName) {
                    const matchingOption = Array.from(departmentDropdown.options).find(opt => (opt.textContent || '').trim().toLowerCase() === targetDeptName.toLowerCase());
                    if (matchingOption) {
                        departmentDropdown.value = matchingOption.value;
                    }
                }
            });

            // --- Initialize Address Dropdowns for Edit Modal ---
            initializeAddressDropdownsForEdit(user);

            // --- Show Modal ---
            editUserModal.querySelector('.main-tab-button').click();
            editUserModal.classList.remove('hidden');
        };

        const toYMD = (val) => {
            if (val == null) return null;
            const s = String(val).trim();
            if (!s) return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            const d = new Date(s);
            if (isNaN(d.getTime())) return s;
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        };

        searchBox.addEventListener('input', (e) => {
            searchTerm = e.target.value.toLowerCase();
            currentPage = 1;
            renderTable();
        });

        pageSizeSelect.addEventListener('change', (e) => {
            pageSize = parseInt(e.target.value, 10);
            currentPage = 1;
            renderTable();
        });

        withEmailCheckbox.addEventListener('change', () => {
            showWithEmail = withEmailCheckbox.checked;
            currentPage = 1;
            renderTable();
        });

        withoutEmailCheckbox.addEventListener('change', () => {
            showWithoutEmail = withoutEmailCheckbox.checked;
            currentPage = 1;
            renderTable();
        });

        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        });

        nextBtn.addEventListener('click', () => {
            const totalPages = Math.ceil(allUsers.length / pageSize);
            if (currentPage < totalPages) {
                currentPage++;
                renderTable();
            }
        });

        logoutBtn.addEventListener('click', async () => {
            try {
                await fetch(`${API_BASE}/api/logout`, { method: 'POST', credentials: 'include' });
            } catch (_) { /* ignore network errors for logout */ }
            sessionStorage.removeItem('isLoggedIn');
            window.location.href = 'index.html';
        });

        if (newUserBtn && newUserForm && newUserModal) {
            newUserBtn.addEventListener('click', () => {
                newUserForm.reset();
                clearAllNewUserFieldErrors();
                if (newUserFormError) newUserFormError.textContent = '';
                const provinceEl = document.getElementById('newProvince');
                if (provinceEl) provinceEl.dispatchEvent(new Event('change'));
                const deptEl = document.getElementById('newDepartmentName');
                if (deptEl) populateDepartmentsDropdown(deptEl);
                newUserModal.classList.remove('hidden');
            });
        }

        if (cancelNewUserBtn && newUserModal) {
            cancelNewUserBtn.addEventListener('click', () => newUserModal.classList.add('hidden'));
        }

        if (newUserForm) {
            newUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                newUserFormError.textContent = '';
                clearAllNewUserFieldErrors();

                const passwordInput = document.getElementById('newPassword');
                const confirmInput = document.getElementById('newPasswordConfirm');
                const password = (passwordInput && passwordInput.value) ? passwordInput.value : '';
                const confirmPassword = (confirmInput && confirmInput.value) ? confirmInput.value : '';

                if (!password || !confirmPassword) {
                    markFieldError(passwordInput, 'Password is required.');
                    markFieldError(confirmInput, 'Password confirmation is required.');
                    newUserFormError.textContent = 'Please enter and confirm the password.';
                    return;
                }
                if (password !== confirmPassword) {
                    markFieldError(confirmInput, 'Passwords do not match.');
                    newUserFormError.textContent = 'Password and Confirm Password do not match.';
                    return;
                }

                const firstName = document.getElementById('newFirstName')?.value?.trim() || '';
                const middleName = document.getElementById('newMiddleName')?.value?.trim() || '';
                const lastName = document.getElementById('newLastName')?.value?.trim() || '';
                const email = document.getElementById('newEmail')?.value?.trim() || '';
                const position = document.getElementById('newPosition')?.value?.trim() || '';
                const mobileNumber = document.getElementById('newContact')?.value?.trim() || '';
                const rfId = document.getElementById('newRfid')?.value?.trim() || '';
                const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

                const deptSelect = document.getElementById('newDepartmentName');
                const selectedDeptOption = deptSelect?.selectedOptions?.[0] || null;
                let departmentId = null;
                if (selectedDeptOption && selectedDeptOption.value) {
                    const parsedId = parseInt(selectedDeptOption.value, 10);
                    if (!isNaN(parsedId)) {
                        departmentId = parsedId;
                    }
                }

                const departmentName = (departmentId && selectedDeptOption) ? (selectedDeptOption.textContent || '').trim() : null;

                const province = document.getElementById('newProvince')?.selectedOptions?.[0]?.textContent.trim() || null;
                const city = document.getElementById('newCity')?.selectedOptions?.[0]?.textContent.trim() || null;
                const barangay = document.getElementById('newBarangay')?.selectedOptions?.[0]?.textContent.trim() || null;
                const birthday = toYMD(document.getElementById('newBirthday')?.value?.trim() || null);
                const dateOfHire = toYMD(document.getElementById('newDateHired')?.value?.trim() || null);

                const tin = document.getElementById('newTin')?.value?.trim() || '';
                const sss = document.getElementById('newSss')?.value?.trim() || '';
                const philhealth = document.getElementById('newPhilhealth')?.value?.trim() || '';
                // Additional fields to mirror /api/users
                const image = document.getElementById('newImage')?.value?.trim() || '';
                const externalId = document.getElementById('newExternalId')?.value?.trim() || '';
                const roleIdRaw = document.getElementById('newRoleId')?.value?.trim() || '';
                const tags = document.getElementById('newTags')?.value?.trim() || '';
                const branchIdRaw = document.getElementById('newBranchId')?.value?.trim() || '';
                const branchName = document.getElementById('newBranchName')?.value?.trim() || '';
                const operationIdRaw = document.getElementById('newOperationId')?.value?.trim() || '';
                const isActiveNew = document.getElementById('newIsActive') ? document.getElementById('newIsActive').checked : true;

                const toNumOrNull = (v) => {
                    const n = parseInt(v, 10);
                    return Number.isNaN(n) ? null : n;
                };
                const roleId = toNumOrNull(roleIdRaw);
                const branchId = toNumOrNull(branchIdRaw);
                const operationId = toNumOrNull(operationIdRaw);

                if (departmentId == null) {
                    markFieldError(deptSelect, 'Please select a department.');
                    newUserFormError.textContent = 'A department must be selected.';
                    return;
                }

                const payload = {
                    fullName, email, password, position, mobileNumber, rfId,
                    departmentId, departmentName, province, city, barangay,
                    birthday, dateOfHire, tin, sss, philhealth,
                    image: image || null, isActive: !!isActiveNew,
                    externalId: externalId || null, roleId: roleId ?? null,
                    tags: tags || null, branchId: branchId ?? null, branchName: branchName || null,
                    operationId: operationId ?? null, isDeleted: null, token: null
                };

                if (usersLoaded) {
                    const dup = findDuplicatesInAllUsers({ email, rfId });
                    if (dup.email || dup.rfId) {
                        const inputs = getNewUserInputs();
                        const parts = [];
                        if (dup.email && email) {
                            markFieldError(inputs.email, 'Email already exists.');
                            parts.push('email');
                        }
                        if (dup.rfId && rfId) {
                            markFieldError(inputs.rfid, 'RFID already exists.');
                            parts.push('RFID');
                        }
                        if (parts.length > 0) {
                            newUserFormError.textContent = `Duplicate ${parts.join(' and ')}. Please use a unique value.`;
                            return;
                        }
                    }
                }

                try {
                    const resp = await fetch(USERS_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const data = await resp.json().catch(() => ({}));
                    if (!resp.ok) {
                        if (resp.status === 409) {
                            const msg = data?.message || 'A user with this email or RFID already exists.';
                            markFieldError(getNewUserInputs().email);
                            markFieldError(getNewUserInputs().rfid);
                            newUserFormError.textContent = `Failed to register: ${msg}`;
                            return;
                        }
                        throw new Error(data?.message || `Request failed with status ${resp.status}`);
                    }
                    newUserModal.classList.add('hidden');
                    await initializeUserTable();
                } catch (err) {
                    console.error('Create user failed:', err);
                    newUserFormError.textContent = `Failed to register user: ${err?.message || err}`;
                }
            });
        }

        cancelEditUserBtn.addEventListener('click', () => editUserModal.classList.add('hidden'));

        editUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            editUserFormError.textContent = '';
            clearAllEditUserFieldErrors();

            const passwordInput = document.getElementById('editPassword');
            const confirmInput = document.getElementById('editPasswordConfirm');
            const password = passwordInput.value;
            const confirmPassword = confirmInput.value;

            if (password || confirmPassword) {
                if (password !== confirmPassword) {
                    editUserFormError.textContent = 'New Password and Confirm Password do not match.';
                    markFieldError(passwordInput, 'Passwords do not match.');
                    markFieldError(confirmInput, 'Passwords do not match.');
                    confirmInput.focus();
                    return;
                }
            }

            const userId = document.getElementById('editUserId').value;
            if (!userId) {
                editUserFormError.textContent = 'Cannot update user: User ID is missing.';
                return;
            }

            const firstName = document.getElementById('editFirstName')?.value?.trim() || '';
            const middleName = document.getElementById('editMiddleName')?.value?.trim() || '';
            const lastName = document.getElementById('editLastName')?.value?.trim() || '';
            const email = document.getElementById('editEmail')?.value?.trim() || '';
            const position = document.getElementById('editPosition')?.value?.trim() || '';
            const mobileNumber = document.getElementById('editContact')?.value?.trim() || '';
            const rfId = document.getElementById('editRfid')?.value?.trim() || '';
            const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

            const deptSelect = document.getElementById('editDepartmentName');
            const selectedEditDeptOption = deptSelect?.selectedOptions?.[0] || null;
            let departmentId = null;
            if (selectedEditDeptOption && selectedEditDeptOption.value) {
                const parsedId = parseInt(selectedEditDeptOption.value, 10);
                if (!isNaN(parsedId)) {
                    departmentId = parsedId;
                }
            }
            const departmentName = (departmentId && selectedEditDeptOption) ? (selectedEditDeptOption.textContent || '').trim() : null;

            const province = document.getElementById('editProvince')?.selectedOptions?.[0]?.textContent.trim() || null;
            const city = document.getElementById('editCity')?.selectedOptions?.[0]?.textContent.trim() || null;
            const barangay = document.getElementById('editBarangay')?.selectedOptions?.[0]?.textContent.trim() || null;

            const birthday = toYMD(document.getElementById('editBirthday')?.value?.trim() || null);
            const dateOfHire = toYMD(document.getElementById('editDateHired')?.value?.trim() || null);

            const tin = document.getElementById('editTin')?.value?.trim() || '';
            const sss = document.getElementById('editSss')?.value?.trim() || '';
            const philhealth = document.getElementById('editPhilhealth')?.value?.trim() || '';
            const isActive = document.getElementById('editIsActive').checked;
            // Additional fields to mirror /api/users
            const image = document.getElementById('editImage')?.value?.trim() || '';
            const externalId = document.getElementById('editExternalId')?.value?.trim() || '';
            const roleIdRaw = document.getElementById('editRoleId')?.value?.trim() || '';
            const tags = document.getElementById('editTags')?.value?.trim() || '';
            const branchIdRaw = document.getElementById('editBranchId')?.value?.trim() || '';
            const branchName = document.getElementById('editBranchName')?.value?.trim() || '';
            const operationIdRaw = document.getElementById('editOperationId')?.value?.trim() || '';
            const toNumOrNullEdit = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
            const roleId = toNumOrNullEdit(roleIdRaw);
            const branchId = toNumOrNullEdit(branchIdRaw);
            const operationId = toNumOrNullEdit(operationIdRaw);

            if (departmentId == null) {
                markFieldError(deptSelect, 'Please select a department.');
                editUserFormError.textContent = 'A department must be selected.';
                return;
            }

            if (usersLoaded) {
                const dup = findDuplicatesInAllUsers({ email, rfId }, parseInt(userId, 10));
                if (dup.email || dup.rfId) {
                    const inputs = getEditUserInputs();
                    const parts = [];
                    if (dup.email && email) {
                        markFieldError(inputs.email, 'Email is already used by another user.');
                        parts.push('email');
                    }
                    if (dup.rfId && rfId) {
                        markFieldError(inputs.rfid, 'RFID is already used by another user.');
                        parts.push('RFID');
                    }
                    if (parts.length > 0) {
                        editUserFormError.textContent = `The updated ${parts.join(' and ')} is already in use.`;
                        return;
                    }
                }
            }

            const payload = {
                fullName, email, position, mobileNumber, rfId,
                departmentId, departmentName, province, city, barangay,
                birthday, dateOfHire, tin, sss, philhealth, isActive,
                image: image || null, externalId: externalId || null,
                roleId: roleId ?? null, tags: tags || null,
                branchId: branchId ?? null, branchName: branchName || null,
                operationId: operationId ?? null
            };

            if (password) {
                payload.password = password;
            }

            try {
                const UPDATE_API_URL = `${USERS_API_URL}/${userId}`;
                const resp = await fetch(UPDATE_API_URL, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    throw new Error(data?.message || `Failed to update user (status ${resp.status})`);
                }
                editUserModal.classList.add('hidden');
                await initializeUserTable();
            } catch (err) {
                console.error('Update user failed:', err);
                editUserFormError.textContent = `Update failed: ${err?.message || err}`;
            }
        });

        const initializeUserTable = async () => {
            try {
                const response = await fetch(USERS_API_URL);
                if (!response.ok) throw new Error("Failed to fetch users");
                const responseData = await response.json();
                let usersList = responseData.data || responseData.content || responseData;
                if (!Array.isArray(usersList)) throw new Error('User data from API is not a valid array.');
                allUsers = usersList;
                usersLoaded = true;
                renderTable();
            } catch (error) {
                console.error("Initialization failed:", error);
                usersLoaded = false;
                allUsers = [];
                usersTbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger py-4">Error loading user data.</td></tr>`;
            }
        };

        const initializeAddressDropdownsForEdit = (user = {}) => {
            const provinceSelect = document.getElementById('editProvince');
            const citySelect = document.getElementById('editCity');
            const barangaySelect = document.getElementById('editBarangay');
            if (!provinceSelect || !citySelect || !barangaySelect || !allProvinces || allProvinces.length === 0) return;

            const populateAndSelect = () => {
                provinceSelect.innerHTML = '<option value="">Select a Province</option>';
                allProvinces.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.prov_code;
                    opt.textContent = p.prov_desc;
                    provinceSelect.appendChild(opt);
                });

                const userProvince = (user.province || '').trim();
                const matchingProvince = allProvinces.find(p => p.prov_desc === userProvince);
                if (matchingProvince) {
                    provinceSelect.value = matchingProvince.prov_code;
                }
                handleEditProvinceChange();

                const userCity = (user.city || '').trim();
                const matchingCity = allCities.find(c => c.prov_code === provinceSelect.value && c.city_desc === userCity);
                if (matchingCity) {
                    citySelect.value = matchingCity.city_code;
                }
                handleEditCityChange();

                const userBarangay = (user.barangay || '').trim();
                const matchingBarangay = allBarangays.find(b => b.city_code === citySelect.value && b.brgy_desc === userBarangay);
                if (matchingBarangay) {
                    barangaySelect.value = matchingBarangay.brgy_code;
                }
            };

            const handleEditProvinceChange = () => {
                const provinceCode = provinceSelect.value;
                citySelect.innerHTML = '<option value="">Select a City / Municipality</option>';
                barangaySelect.innerHTML = '<option value="">Select a city first</option>';
                citySelect.disabled = !provinceCode;
                barangaySelect.disabled = true;
                if (!provinceCode) return;

                allCities.filter(c => c.prov_code === provinceCode).forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.city_code;
                    opt.textContent = c.city_desc;
                    citySelect.appendChild(opt);
                });
            };

            const handleEditCityChange = () => {
                const cityCode = citySelect.value;
                barangaySelect.innerHTML = '<option value="">Select a Barangay</option>';
                barangaySelect.disabled = !cityCode;
                if (!cityCode) return;

                allBarangays.filter(b => b.city_code === cityCode).forEach(b => {
                    const opt = document.createElement('option');
                    opt.value = b.brgy_code;
                    opt.textContent = b.brgy_desc;
                    barangaySelect.appendChild(opt);
                });
            };

            provinceSelect.removeEventListener('change', handleEditProvinceChange);
            citySelect.removeEventListener('change', handleEditCityChange);
            provinceSelect.addEventListener('change', handleEditProvinceChange);
            citySelect.addEventListener('change', handleEditCityChange);

            populateAndSelect();
        };

        const initializeAddressDropdowns = () => {
            const provinceSelect = document.getElementById('newProvince');
            const citySelect = document.getElementById('newCity');
            const barangaySelect = document.getElementById('newBarangay');
            if (!provinceSelect || !citySelect || !barangaySelect) return;

            const ADDRESS_API_URLS = {
                provinces: `${API_BASE}/api/provinces`,
                cities: `${API_BASE}/api/cities`,
                barangays: `${API_BASE}/api/barangays`
            };

            async function fetchAllData() {
                try {
                    provinceSelect.innerHTML = '<option>Loading addresses...</option>';
                    provinceSelect.disabled = true;
                    citySelect.disabled = true;
                    barangaySelect.disabled = true;

                    const [provRes, cityRes, bgyRes] = await Promise.all([
                        fetch(ADDRESS_API_URLS.provinces),
                        fetch(ADDRESS_API_URLS.cities),
                        fetch(ADDRESS_API_URLS.barangays)
                    ]);
                    if (!provRes.ok || !cityRes.ok || !bgyRes.ok) {
                        throw new Error('Failed to fetch address data from server.');
                    }

                    const [rawProvinces, rawCities, rawBarangays] = await Promise.all([
                        provRes.json(), cityRes.json(), bgyRes.json()
                    ]);

                    allProvinces = rawProvinces.map(p => ({
                        prov_code: p.prov_code || p.province_code,
                        prov_desc: p.prov_desc || p.province_name,
                    })).sort((a, b) => a.prov_desc.localeCompare(b.prov_desc));

                    allCities = rawCities.map(c => ({
                        city_code: c.city_code,
                        city_desc: c.city_desc || c.city_name,
                        prov_code: c.prov_code || c.province_code
                    })).sort((a, b) => a.city_desc.localeCompare(b.city_desc));

                    allBarangays = rawBarangays.map(b => ({
                        brgy_code: b.brgy_code,
                        brgy_desc: b.brgy_desc || b.brgy_name,
                        city_code: b.city_code,
                    })).sort((a, b) => a.brgy_desc.localeCompare(b.brgy_desc));

                    populateProvinces();

                    provinceSelect.removeEventListener('change', handleProvinceChange);
                    citySelect.removeEventListener('change', handleCityChange);
                    provinceSelect.addEventListener('change', handleProvinceChange);
                    citySelect.addEventListener('change', handleCityChange);
                } catch (err) {
                    console.error('Address Initialization Error:', err);
                    provinceSelect.innerHTML = `<option value="">Error loading addresses</option>`;
                }
            }

            function populateProvinces() {
                provinceSelect.innerHTML = '<option value="">Select a Province</option>';
                allProvinces.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.prov_code;
                    opt.textContent = p.prov_desc;
                    provinceSelect.appendChild(opt);
                });
                provinceSelect.disabled = false;
                handleProvinceChange();
            }

            function handleProvinceChange() {
                const provinceCode = provinceSelect.value;
                citySelect.innerHTML = '<option value="">Select a City / Municipality</option>';
                citySelect.disabled = !provinceCode;
                if (provinceCode) {
                    allCities.filter(c => c.prov_code === provinceCode).forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.city_code;
                        opt.textContent = c.city_desc;
                        citySelect.appendChild(opt);
                    });
                }
                handleCityChange();
            }

            function handleCityChange() {
                const cityCode = citySelect.value;
                barangaySelect.innerHTML = '<option value="">Select a Barangay</option>';
                barangaySelect.disabled = !cityCode;
                if (cityCode) {
                    allBarangays.filter(b => b.city_code === cityCode).forEach(b => {
                        const opt = document.createElement('option');
                        opt.value = b.brgy_code;
                        opt.textContent = b.brgy_desc;
                        barangaySelect.appendChild(opt);
                    });
                }
            }

            fetchAllData();
        };

        // Initialize all functionalities for the page
        initializeUserTable();
        initializeAddressDropdowns();
    };

    handleLoginPage();
    handleUserListPage();
});