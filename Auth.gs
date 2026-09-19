/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Auth.gs — Authentication, session management dan Role Based Access Control.
 *
 * ATURAN KEAMANAN:
 *   - Role TIDAK PERNAH dipercaya dari frontend. Setiap request membawa token,
 *     server membaca role dari session store.
 *   - Seluruh server function sensitif memanggil requireAuth()/requirePermission().
 *   - Password disimpan sebagai sha256$<salt>$<hash>. Plain text hanya
 *     ditoleransi untuk data demo lama dan langsung di-upgrade saat login.
 * ============================================================================
 */

var Auth = (function () {

  var SESSION_CACHE_PREFIX = 'MRD_SESSION_';
  var ATTEMPT_PREFIX = 'MRD_LOGIN_ATTEMPT_';

  // -------------------------------------------------------------------------
  // Password
  // -------------------------------------------------------------------------

  function randomSalt() {
    return Utils.uuid().substring(0, 12);
  }

  function sha256Hex(text) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
    return bytes.map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
  }

  /** Hash password baru: sha256$<salt>$<hex>. */
  function hashPassword(plain, salt) {
    var s = salt || randomSalt();
    return 'sha256$' + s + '$' + sha256Hex(s + '::' + Utils.str(plain));
  }

  /** Verifikasi password terhadap nilai tersimpan. */
  function verifyPassword(plain, stored) {
    var value = Utils.str(stored);
    if (!value) return false;
    var parts = value.split('$');
    if (parts.length === 3 && parts[0] === 'sha256') {
      return hashPassword(plain, parts[1]) === value;
    }
    // Kompatibilitas data demo lama (plain text) — akan di-upgrade otomatis.
    return value === Utils.str(plain);
  }

  function isLegacyHash(stored) {
    var value = Utils.str(stored);
    return value.indexOf('sha256$') !== 0;
  }

  // -------------------------------------------------------------------------
  // Session store (CacheService + ScriptProperties fallback)
  // -------------------------------------------------------------------------

  function sessionTtlSeconds() {
    var minutes = Settings.getNumber('SESSION_TIMEOUT_MINUTES', 240);
    return Math.max(300, Math.min(21600, Math.round(minutes * 60)));
  }

  function saveSession(session) {
    var json = JSON.stringify(session);
    try {
      CacheService.getScriptCache().put(SESSION_CACHE_PREFIX + session.token, json, sessionTtlSeconds());
    } catch (e) {
      console.warn('Gagal menulis session ke cache: ' + e);
    }
    PropertiesService.getScriptProperties().setProperty(PROP_KEYS.SESSION_PREFIX + session.token, json);
  }

  function readSession(token) {
    if (!token) return null;
    var json = null;
    try {
      json = CacheService.getScriptCache().get(SESSION_CACHE_PREFIX + token);
    } catch (e) { /* lanjut ke fallback */ }
    if (!json) {
      json = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SESSION_PREFIX + token);
    }
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function dropSession(token) {
    if (!token) return;
    try { CacheService.getScriptCache().remove(SESSION_CACHE_PREFIX + token); } catch (e) { /* noop */ }
    PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.SESSION_PREFIX + token);
  }

  /** Bersihkan session kedaluwarsa dari ScriptProperties (dipanggil sesekali). */
  function sweepExpiredSessions() {
    try {
      var props = PropertiesService.getScriptProperties();
      var all = props.getProperties();
      var now = Date.now();
      var removed = 0;
      Object.keys(all).forEach(function (key) {
        if (key.indexOf(PROP_KEYS.SESSION_PREFIX) !== 0 || removed > 80) return;
        try {
          var session = JSON.parse(all[key]);
          if (!session.expiresAt || new Date(session.expiresAt).getTime() < now) {
            props.deleteProperty(key);
            removed++;
          }
        } catch (e) {
          props.deleteProperty(key);
          removed++;
        }
      });
    } catch (e) {
      console.warn('sweepExpiredSessions gagal: ' + e);
    }
  }

  // -------------------------------------------------------------------------
  // Rate limiting login
  // -------------------------------------------------------------------------

  function attemptKey(username) {
    return ATTEMPT_PREFIX + Utils.normalize(username);
  }

  function getAttempts(username) {
    try {
      return Number(CacheService.getScriptCache().get(attemptKey(username)) || 0);
    } catch (e) {
      return 0;
    }
  }

  function bumpAttempts(username) {
    try {
      var lockMinutes = Settings.getNumber('LOGIN_LOCKOUT_MINUTES', 15);
      var next = getAttempts(username) + 1;
      CacheService.getScriptCache().put(attemptKey(username), String(next), Math.round(lockMinutes * 60));
      return next;
    } catch (e) {
      return 0;
    }
  }

  function clearAttempts(username) {
    try { CacheService.getScriptCache().remove(attemptKey(username)); } catch (e) { /* noop */ }
  }

  // -------------------------------------------------------------------------
  // Login / Logout
  // -------------------------------------------------------------------------

  /**
   * Proses login.
   * @return {Object} { token, user, navigation, permissions }
   */
  function login(username, password) {
    var uname = Utils.str(username);
    if (!uname || Utils.str(password) === '') {
      throwError('AUTH_INVALID_INPUT', 'Username dan password wajib diisi.');
    }

    var maxAttempts = Settings.getNumber('LOGIN_MAX_ATTEMPTS', 5);
    if (getAttempts(uname) >= maxAttempts) {
      throwError('AUTH_LOCKED',
        'Terlalu banyak percobaan login gagal. Coba lagi dalam '
        + Settings.getNumber('LOGIN_LOCKOUT_MINUTES', 15) + ' menit.');
    }

    var user = UserRepo.findByUsername(uname);
    if (!user || !verifyPassword(password, user.PASSWORD_HASH)) {
      bumpAttempts(uname);
      AuditService.log({
        user: uname, action: AUDIT_ACTIONS.LOGIN_FAILED, module: AuditService.MODULES.AUTH,
        recordId: user ? user.USER_ID : '-', description: 'Percobaan login gagal untuk username ' + uname
      });
      throwError('AUTH_FAILED', 'Username atau password salah.');
    }

    if (Utils.upper(user.STATUS) !== 'ACTIVE') {
      throwError('AUTH_INACTIVE', 'Akun Anda tidak aktif. Hubungi administrator.');
    }

    clearAttempts(uname);

    // Upgrade password lama ke hash modern secara transparan.
    if (isLegacyHash(user.PASSWORD_HASH)) {
      try {
        UserRepo.update(user.USER_ID, { PASSWORD_HASH: hashPassword(password) });
      } catch (e) {
        console.warn('Gagal upgrade hash password untuk ' + uname + ': ' + e);
      }
    }

    if (Math.random() < 0.15) sweepExpiredSessions();

    var now = new Date();
    var session = {
      token: Utils.uuid(),
      userId: user.USER_ID,
      username: user.USERNAME,
      name: user.NAME,
      role: Utils.upper(user.ROLE),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + sessionTtlSeconds() * 1000).toISOString()
    };
    saveSession(session);

    AuditService.log({
      user: user.USERNAME, action: AUDIT_ACTIONS.LOGIN, module: AuditService.MODULES.AUTH,
      recordId: user.USER_ID, description: 'Login berhasil sebagai ' + session.role
    });

    return buildSessionPayload(session, user);
  }

  function logout(token) {
    var session = readSession(token);
    if (session) {
      AuditService.log({
        user: session.username, action: AUDIT_ACTIONS.LOGOUT, module: AuditService.MODULES.AUTH,
        recordId: session.userId, description: 'Logout dari aplikasi'
      });
    }
    dropSession(token);
    return true;
  }

  /** Payload sesi yang dikirim ke frontend setelah login / refresh. */
  function buildSessionPayload(session, userRow) {
    var user = userRow || UserRepo.findById(session.userId);
    return {
      token: session.token,
      user: UserRepo.publicProfile(user) || {
        USER_ID: session.userId, USERNAME: session.username, NAME: session.name,
        ROLE: session.role, INITIALS: Utils.str(session.name).charAt(0).toUpperCase()
      },
      navigation: navigationForRole(session.role),
      permissions: permissionsForRole(session.role),
      expiresAt: session.expiresAt,
      app: {
        name: Settings.get('APP_NAME', APP.NAME),
        version: Settings.get('APP_VERSION', APP.VERSION),
        subtitle: APP.SUBTITLE,
        objective: APP.OBJECTIVE,
        currencySymbol: Settings.get('CURRENCY_SYMBOL', 'Rp'),
        dateFormat: Settings.get('DATE_FORMAT', 'dd MMM yyyy'),
        pageSize: Settings.getNumber('DEFAULT_PAGE_SIZE', 25),
        targetMrPercent: Settings.getNumber('TARGET_MR_PERCENT', 5)
      }
    };
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /**
   * Pastikan token valid & belum kedaluwarsa. Memperpanjang sesi (sliding).
   * @return {Object} session
   */
  function requireAuth(token) {
    var session = readSession(token);
    if (!session) {
      throwError('AUTH_REQUIRED', 'Sesi Anda sudah berakhir. Silakan login kembali.');
    }
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      dropSession(token);
      throwError('AUTH_EXPIRED', 'Sesi Anda sudah berakhir. Silakan login kembali.');
    }
    // Sliding expiration — perpanjang hanya bila sisa waktu < 50% TTL.
    var ttlMs = sessionTtlSeconds() * 1000;
    var remaining = new Date(session.expiresAt).getTime() - Date.now();
    if (remaining < ttlMs / 2) {
      session.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      session.lastSeenAt = new Date().toISOString();
      saveSession(session);
    }
    return session;
  }

  /** Pastikan role user termasuk dalam daftar yang diizinkan. */
  function requireRole(token, roles) {
    var session = requireAuth(token);
    var allowed = [].concat(roles || []);
    if (allowed.length && allowed.indexOf(session.role) === -1) {
      throwError('FORBIDDEN', 'Role ' + session.role + ' tidak memiliki akses untuk tindakan ini.');
    }
    return session;
  }

  /** Pastikan user memiliki permission (sumber: PERMISSIONS di Config.gs). */
  function requirePermission(token, permission) {
    var session = requireAuth(token);
    if (permission && !roleHasPermission(session.role, permission)) {
      throwError('FORBIDDEN',
        'Anda tidak memiliki akses untuk tindakan ini (' + permission + '). Hubungi administrator.');
    }
    return session;
  }

  /** Ambil sesi aktif tanpa melempar error (untuk boot screen). */
  function peek(token) {
    var session = readSession(token);
    if (!session) return null;
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return null;
    return session;
  }

  /** Ganti password milik sendiri. */
  function changePassword(token, currentPassword, newPassword) {
    var session = requireAuth(token);
    var user = UserRepo.findById(session.userId);
    if (!user) throwError('NOT_FOUND', 'User tidak ditemukan.');
    if (!verifyPassword(currentPassword, user.PASSWORD_HASH)) {
      throwError('AUTH_FAILED', 'Password saat ini tidak sesuai.');
    }
    if (Utils.str(newPassword).length < 6) {
      throwError('VALIDATION_ERROR', 'Password baru minimal 6 karakter.');
    }
    UserRepo.update(user.USER_ID, { PASSWORD_HASH: hashPassword(newPassword) });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.AUTH,
      recordId: user.USER_ID, description: 'Perubahan password oleh user sendiri'
    });
    return true;
  }

  return {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    login: login,
    logout: logout,
    requireAuth: requireAuth,
    requireRole: requireRole,
    requirePermission: requirePermission,
    peek: peek,
    buildSessionPayload: buildSessionPayload,
    changePassword: changePassword
  };
})();

/** Guard global (alias sesuai penamaan pada PRD bagian U). */
function requireAuth(token) { return Auth.requireAuth(token); }
function requireRole(token, roles) { return Auth.requireRole(token, roles); }
function requirePermission(token, permission) { return Auth.requirePermission(token, permission); }
