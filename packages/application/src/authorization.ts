type AuthorizationInput = {
  roles: readonly string[];
  actorCommunityId: string;
  resourceCommunityId: string;
  capability: string;
};

const PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "community:update": ["community-admin"],
  "event:create": ["community-admin", "organizer"],
  "event:update": ["community-admin", "organizer"],
  "event:moderate": ["community-admin", "organizer"],
  "guest:suspend": ["community-admin", "organizer"],
  "guest:remove": ["community-admin", "organizer"],
  "ballot:replace": ["participant", "organizer", "community-admin"],
  "proposal:create": ["participant", "organizer", "community-admin"],
  "proposal:moderate": ["organizer", "community-admin"],
  "ballot:inspect-individual": ["community-admin"],
});

export function authorize(input: AuthorizationInput): { allowed: boolean; reason: string } {
  if (input.actorCommunityId !== input.resourceCommunityId) return { allowed: false, reason: "community-mismatch" };
  const allowedRoles = PERMISSIONS[input.capability];
  if (!allowedRoles) return { allowed: false, reason: "capability-denied" };
  return input.roles.some((role) => allowedRoles.includes(role))
    ? { allowed: true, reason: "allowed" }
    : { allowed: false, reason: "role-denied" };
}

export { PERMISSIONS };
