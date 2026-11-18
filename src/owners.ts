import type { Dialect } from './types.js';

export type OwnerKind = 'user' | 'team' | 'email' | 'role' | 'invalid';

// GitHub usernames: 1-39 alphanumerics or single hyphens, no leading/trailing hyphen.
const GITHUB_USER = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// GitHub teams: @org/team-slug.
const GITHUB_TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// GitLab users and (nested) groups: @name, @group/subgroup/...
const GITLAB_USER = /^@[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const GITLAB_GROUP = /^@[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/;
// GitLab roles: @@developer, @@maintainer, @@owner (plural forms accepted too).
const GITLAB_ROLE = /^@@(?:developer|maintainer|owner)s?$/i;
// Deliberately loose: one @, a dot in the domain, no whitespace.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Classifies an owner token. This is a syntax check only: whether the user,
 * team or address exists and has write access can only be checked by the
 * hosting service.
 */
export function classifyOwner(owner: string, dialect: Dialect = 'github'): OwnerKind {
  if (EMAIL.test(owner) && !owner.startsWith('@')) return 'email';
  if (dialect === 'gitlab') {
    if (GITLAB_ROLE.test(owner)) return 'role';
    if (GITLAB_GROUP.test(owner)) return 'team';
    if (GITLAB_USER.test(owner)) return 'user';
    return 'invalid';
  }
  if (GITHUB_TEAM.test(owner)) return 'team';
  if (GITHUB_USER.test(owner)) return 'user';
  return 'invalid';
}

export function isValidOwner(owner: string, dialect: Dialect = 'github'): boolean {
  return classifyOwner(owner, dialect) !== 'invalid';
}
