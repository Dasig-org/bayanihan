import { authorize, type BixResource, type Directory } from "@bayanihan/core";
import { permissionsForRecord } from "./auth.js";

const ref = (x: unknown) => (x as { reference?: string } | undefined)?.reference;
const draft = (r: BixResource) => r["status"] === "draft" || r["intent"] === "proposal";

/** May this person create this new record? Everything not listed is refused. */
export function canCreate(me: string, r: BixResource, dir: Directory, o: { ownsParent?: boolean } = {}): string | null {
  const perms = new Set(permissionsForRecord(me, r, dir));
  const member = perms.has("member") || perms.has("team.member");
  switch (r.resourceType) {
    case "Organization": return null; // anyone may start a group; the server makes them its officer
    case "Person": if (r["publicKey"]) return "only the person can add their own keys";
    case "Person": return ref(r["managedBy"]) && perms.has("member.manage") ? null : "people create their own Person by signing in, or a group adds a nickname";
    case "Role": {
      if (perms.has("member.manage")) return null;
      if (ref(r["person"]) === me && r["status"] === "requested") return null; // asking to join
      return "adding someone to a group needs member.manage";
    }
    case "Initiative": case "Team": case "Position": case "InitiativeTemplate": case "Goal": case "SharingPolicy": case "TaskDefinition": case "Report":
      if (r.resourceType === "Report") return perms.has("report.submit") ? null : "sending a report needs report.submit (officers have it)";
      if (r.resourceType === "Initiative" && ref(r["person"]) === me && !ref(r["organization"])) return null; // personal project
      if (r.resourceType === "Goal" && (perms.has("org.manage") || perms.has("initiative.plan"))) return null;
      return perms.has("initiative.plan") || perms.has("org.manage") ? null : "planning needs initiative.plan";
    case "Task": case "Need": case "Offer": case "Decision": {
      if (ref(r["owner"]) === me && !dir.initiatives.length) return null; // personal task
      if (dir.initiatives.some((i) => ref(i["person"]) === me)) return null; // in my personal project
      if (draft(r) && member) return null; // anyone on the team may propose
      // BIX "Who may change what on a Task": the owner of a Task may add subtasks under it (partOf), for themselves or
      // open to the team; asking someone else to do one stays with task.assign.
      if (r.resourceType === "Task" && o.ownsParent && r["status"] !== "requested" && (!ref(r["owner"]) || ref(r["owner"]) === me || ref(r["owner"])!.startsWith("Team/"))) return null;
      if (r.resourceType === "Offer" && ref(r["offeredBy"]) === me) return null; // offering help
      return perms.has("task.assign") || perms.has("initiative.plan") ? null : "join the team to suggest work; leads add it directly";
    }
    // BIX "Project memory: Practices", closing a project: a lead keeps a step for next time as the group's own Practice
    // (rule 4: making one active needs initiative.plan). Its figures are never set by a person (rule 23, also checked in Core).
    case "Practice":
      if (!(perms.has("initiative.plan") || perms.has("org.manage"))) return "keeping a step for next time needs initiative.plan";
      if (r["observed"]) return "a Practice's figures are calculated by rule, never set";
      return r["source"] === "own" ? null : "a group's new Practice is its own (source: own); starters are adopted, not created";
    case "Communication": return ref(r["sender"]) === me ? null : "you can only send as yourself";
    // BIX "Suggestions and their answers": anyone in the group may record "Not this time" (declined) or propose (draft).
    case "ChangeProposal":
      if ((r["area"] as { code?: string } | undefined)?.code !== "memory" || !["declined", "draft"].includes(String(r["status"]))) return "only memory suggestions can be saved this way";
      return dir.roles.some((x) => ref(x["person"]) === me && x["status"] === "active" && ref(x["organization"]) === ref(r["organization"])) ? null : "only people in the group can answer its suggestions";
    case "Vote": return ref(r["voter"]) === me ? null : "you can only vote as yourself";
    case "Follow": return ref(r["follower"]) === me ? null : "you can only follow as yourself";
    case "Consent": return ref(r["person"]) === me ? null : "only you can give your consent";
    case "ShareLink": return perms.has("task.assign") || perms.has("member.manage") || perms.has("org.manage") || perms.has("team.member") ? null : "sharing needs a role in the group";
    default: return "this record is created by the server";
  }
}
export { authorize };
