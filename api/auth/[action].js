// POST /api/auth/login, GET /api/auth/session, POST /api/auth/logout
// 로그인은 서버에서만 Supabase Auth를 부릅니다. 공통 로직은 src/auth-service.mjs 에 있습니다.
import { createAuthService } from '../../src/auth-service.mjs';

export default createAuthService().route;
