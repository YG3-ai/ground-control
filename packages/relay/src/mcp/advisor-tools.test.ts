import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./tools.js";
describe("Advisor MCP wiring", () => {
 it("exposes mission-bound jobs and revisioned plan submission", async () => {
  const registrations = new Map<string, {schema: any; handler: any}>();
  const server = {tool: (name: string, _description: string, schema: any, ...args: any[]) => {
   registrations.set(name, {schema, handler: args.at(-1)});
  }};
  const request=vi.fn().mockResolvedValue({ok:true});
  registerTools(server as never, {request} as never, "owner-test");
  const missionId="11111111-1111-4111-8111-111111111111";
  const start=registrations.get("start_task")!;
  expect(start.schema.mission_id.parse(missionId)).toBe(missionId);
  await start.handler({agent:"cursor",prompt:"Implement",workspace:"demo",mission_id:missionId,tier:"implement"},{});
  expect(request).toHaveBeenCalledWith("start_task",expect.objectContaining({missionId,prompt:"Implement"}),"owner-test");
  await registrations.get("submit_mission_plan")!.handler({mission_id:missionId,plan:"Inspect, implement, verify.",notify:false},{});
  expect(request).toHaveBeenCalledWith("submit_mission_plan",expect.objectContaining({missionId,plan:"Inspect, implement, verify.",notify:false}),"owner-test");
 });
});
