import { authorize, type BixResource, type Directory } from "@bayanihan/core";
import { permissionsForRecord } from "./auth.js";

const ref = (x: unknown) => (x as { reference?: string } | undefined)?.reference;
const draft = (r: BixResource) => r["status"] === "draft" || r["intent"] === "proposal";

/** May this person create this new record? Everything not listed is refused. */
export function canCreate(me: string, r: BixResource, dir: Directory): string | null {
  const perms = new Set(permissionsForRecord(me, r, dir));
  const member = perms.has("member") || perms.has("team.member");
  switch (r.resourceType) {
    case "Organization": return null; // anyone may start a group; the server makes them its officer
    case "Person": return ref(r["managedBy"]) && perms.has("member.manage") ? null : "people create their own Person by signing in, or a group adds a nickname";
    case "Role": {
      if (perms.has("member.manage")) return null;
      if (ref(r["person"]) === me && r["status"] === "requested") return null; // asking to join
      return "adding someone to a group needs member.manage";
    }
    case "Initiative": case "Team": case "Position": case "InitiativeTemplate": case "Goal": case "SharingPolicy": case "TaskDefinition": case "Report":
      if (r.resourceType === "Initiative" && ref(r["person"]) === me && !ref(r["organization"])) return null; // personal project
      if (r.resourceType === "Goal" && (perms.has("org.manage") || perms.has("initiative.plan"))) return null;
      return perms.has("initiative.plan") || perms.has("org.manage") ? null : "planning needs initiative.plan";
    case "Task": case "Need": case "Offer": case "Decision": {
      if (ref(r["owner"]) === me && !dir.initiatives.length) return null; // personal task
      if (dir.initiatives.some((i) => ref(i["person"]) === me)) return null; // in my personal project
      if (draft(r) && member) return null; // anyone on the team may propose
      if (r.resourceType === "Offer" && ref(r["offeredBy"]) === me) return null; // offering help
      return perms.has("task.assign") || perms.has("initiative.plan") ? null : "join the team to suggest work; leads add it directly";
    }
    case "Communication": return ref(r["sender"]) === me ? null : "you can only send as yourself";
    case "Vote": return ref(r["voter"]) === me ? null : "you can only vote as yourself";
    case "Follow": return ref(r["follower"]) === me ? null : "you can only follow as yourself";
    case "Consent": return ref(r["person"]) === me ? null : "only you can give your consent";
    case "ShareLink": return perms.has("task.assign") || perms.has("member.manage") || perms.has("org.manage") || perms.has("team.member") ? null : "sharing needs a role in the group";
    default: return "this record is created by the server";
  }
}
export { authorize };
