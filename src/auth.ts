/**
 * Auth.js (next-auth v5) 설정 — GitHub OAuth.
 *
 * 수집기(Collector) 계층이 GitHub API를 호출하려면 사용자 액세스 토큰이 필요하다.
 * JWT 세션에 access_token을 실어두고 session 콜백에서 노출한다.
 * 스코프: read:user (프로필) + repo (private 레포 포함 전체 이력)
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
// 모듈 확장(declare module)을 위해 side-effect import가 필요하다.
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** GitHub API 호출에 사용할 사용자 액세스 토큰 (서버 세션 한정) */
    accessToken?: string;
    /** GitHub 로그인 핸들 (표시 이름이 아닌 실제 계정명) */
    login?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    login?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      authorization: {
        params: { scope: "read:user repo" },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      // 최초 로그인 시에만 account/profile이 존재한다.
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      // 수집기는 표시 이름이 아니라 GitHub 로그인 핸들을 써야 한다.
      const githubLogin = (profile as { login?: unknown } | undefined)?.login;
      if (typeof githubLogin === "string") {
        token.login = githubLogin;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.login = token.login;
      return session;
    },
  },
});
