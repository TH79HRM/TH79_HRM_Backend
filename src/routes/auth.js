import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Users } from '../models/raw.js';
import { env } from '../config/env.js';
import { permissionSnapshot } from '../services/permissionService.js';
import { audit } from '../services/auditService.js';
import { requireAuth } from '../middleware/auth.js';
import { idVariants } from '../utils/legacyId.js';

const router = Router();

function authSubject(user) {
  return user?._id ? String(user._id) : (user?.id !== undefined ? String(user.id) : null);
}

function safeAuth(auth) {
  if (!auth?.user) return null;
  const { password_hash, password, passwordHash, auth_version, ...user } = auth.user;
  return {
    ...user,
    _id: user?._id ? String(user._id) : user?._id,
    roles: auth.roles || [],
    permissions: auth.permissions || [],
    isSuperAdmin: Boolean(auth.isSuperAdmin),
    legacyIdMissing: Boolean(auth.legacyIdMissing)
  };
}

function isActive(user) {
  return user && (user.status === undefined || user.status === null || ['active', '1', 1, true].includes(user.status));
}

async function passwordMatches(user, password) {
  const rawHash = user?.password_hash || user?.password || user?.passwordHash;
  if (!rawHash) return false;
  const hash = String(rawHash).trim();
  if (hash === password) return true;

  const formattedHash = /^\$2[axy]\$/.test(hash) ? `$2b$${hash.slice(4)}` : hash;
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(formattedHash)) return false;
  return bcrypt.compare(password, formattedHash);
}

function setAuthCookie(res, token) {
  res.cookie('th79_token', token, {
    httpOnly: true,
    sameSite: env.cookieSameSite,
    secure: env.cookieSecure,
    domain: env.cookieDomain,
    maxAge: 12 * 60 * 60 * 1000
  });
}

router.post('/login', async (req, res, next) => {
  try {
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!login || !password) return res.status(400).json({ message: 'Vui lòng nhập tài khoản và mật khẩu.' });

    const loginRegex = new RegExp(`^${login.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    const user = await Users.findOne({
      $or: [
        { username: loginRegex },
        { email: loginRegex },
        { username: login }
      ]
    }).lean();

    if (!isActive(user) || !(await passwordMatches(user, password))) {
      req.auth = null;
      await audit(req, { module: 'auth', action: 'login_failed', description: 'Đăng nhập thất bại', newValues: { login } });
      return res.status(401).json({ message: 'Tài khoản hoặc mật khẩu không đúng.' });
    }

    const rawPassword = user.password_hash || user.password || user.passwordHash;
    if (String(rawPassword).trim() === password && user._id) {
      await Users.updateOne(
        { _id: user._id },
        { $set: { password_hash: await bcrypt.hash(password, 10) }, $unset: { password: 1, passwordHash: 1 } }
      );
    }

    // Update by legacy ID when present, otherwise by Mongo _id. This avoids an
    // empty legacy-id filter on databases created by the earliest converter.
    if (user.id !== null && user.id !== undefined && user.id !== '') {
      await Users.updateOne({ id: { $in: idVariants(user.id) } }, { $set: { last_login_at: new Date(), updated_at: new Date() } });
    } else {
      await Users.updateOne({ _id: user._id }, { $set: { last_login_at: new Date(), updated_at: new Date() } });
    }

    const snapshot = await permissionSnapshot(user);
    if (!snapshot?.user) {
      return res.status(500).json({ message: 'Không thể tạo phiên đăng nhập. Hãy chạy kiểm tra dữ liệu tài khoản.' });
    }

    const uid = authSubject(user);
    if (!uid) return res.status(500).json({ message: 'Tài khoản thiếu định danh đăng nhập.' });

    const token = jwt.sign({ uid, authVersion: Number(user.auth_version || 0) }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    setAuthCookie(res, token);

    req.auth = snapshot;
    await audit(req, {
      module: 'auth', action: 'login', recordType: 'user', recordId: user.id ?? null,
      description: 'Đăng nhập hệ thống thành công'
    });

    return res.json({ user: safeAuth(snapshot), token });
  } catch (error) { next(error); }
});

router.post('/logout', requireAuth, async (req, res) => {
  await audit(req, {
    module: 'auth', action: 'logout', recordType: 'user', recordId: req.auth?.user?.id ?? null,
    description: 'Đăng xuất khỏi hệ thống'
  });
  res.clearCookie('th79_token', { httpOnly: true, sameSite: env.cookieSameSite, secure: env.cookieSecure, domain: env.cookieDomain });
  res.json({ ok: true });
});


// Public bootstrap endpoint for the React app.
// Unlike /me, an anonymous browser receives HTTP 200 instead of 401. This
// prevents a harmless pre-login session check from appearing as a console
// error while still keeping every protected API behind requireAuth.
router.get('/session', async (req, res) => {
  const token = req.cookies?.th79_token || (
    req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null
  );

  if (!token) {
    return res.json({ authenticated: false, user: null });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const snapshot = await permissionSnapshot(payload.uid);

    const authVersion = Number(snapshot?.user?.auth_version || 0);
    if (!isActive(snapshot?.user) || Number(payload.authVersion || 0) !== authVersion) {
      res.clearCookie('th79_token', {
        httpOnly: true,
        sameSite: env.cookieSameSite,
        secure: env.cookieSecure,
        domain: env.cookieDomain
      });
      return res.json({ authenticated: false, user: null });
    }

    return res.json({ authenticated: true, user: safeAuth(snapshot) });
  } catch {
    res.clearCookie('th79_token', {
      httpOnly: true,
      sameSite: env.cookieSameSite,
      secure: env.cookieSecure,
      domain: env.cookieDomain
    });
    return res.json({ authenticated: false, user: null });
  }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: safeAuth(req.auth) }));

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password || '').trim();
    const newPassword = String(req.body?.new_password || '').trim();
    if (!currentPassword || newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ message: 'Mật khẩu mới phải có từ 8 đến 72 ký tự.' });
    }

    const user = req.auth.user;
    if (!(await passwordMatches(user, currentPassword))) {
      return res.status(400).json({ message: 'Mật khẩu hiện tại không đúng.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'Mật khẩu mới phải khác mật khẩu hiện tại.' });
    }

    const authVersion = Number(user.auth_version || 0) + 1;
    const updatedUser = {
      ...user,
      password_hash: await bcrypt.hash(newPassword, 10),
      must_change_password: false,
      auth_version: authVersion,
      updated_at: new Date()
    };
    await Users.updateOne(
      { _id: user._id },
      {
        $set: {
          password_hash: updatedUser.password_hash,
          must_change_password: false,
          auth_version: authVersion,
          password_changed_at: updatedUser.updated_at,
          updated_at: updatedUser.updated_at
        },
        $unset: { password: 1, passwordHash: 1 }
      }
    );

    const token = jwt.sign({ uid: authSubject(user), authVersion }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    setAuthCookie(res, token);
    req.auth = { ...req.auth, user: updatedUser };
    await audit(req, {
      module: 'auth', action: 'password_change', recordType: 'user', recordId: user.id ?? null,
      description: 'Người dùng tự đổi mật khẩu'
    });
    return res.json({ user: safeAuth(req.auth), token });
  } catch (error) { next(error); }
});


export default router;
