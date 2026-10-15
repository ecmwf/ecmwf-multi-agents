// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// driveTurn against a small stand-in for the opencode 2 routes it uses; no opencode.

import { afterEach, describe, expect, test } from "bun:test";
import { Api, driveTurn, Executions } from "./opencode.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import type { FormRequest, PermissionRecord, PermissionRequest, QuestionRecord } from "./types.ts";

const SESSION = "ses_1";

interface Stub {
  permissions: PermissionRequest[];
  forms: FormRequest[];
  /** How each reply or cancel goes, in order: the status to answer with; 204 once the list is used up. */
  permissionReplies: number[];
  formReplies: number[];
  formCancels: number[];
  log: string[];
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(stub: Stub): Api {
  const json = (data: unknown) => Response.json({ data });
  const status = (list: number[]) => new Response(null, { status: list.shift() ?? 204 });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      if (route === `GET /api/session/${SESSION}`) return json({ id: SESSION, agent: "lead" });
      if (route === "GET /api/session") return json([]);
      if (route === `POST /api/session/${SESSION}/prompt`) return json({ id: "msg_1" });
      if (route === "GET /api/session/active") return json({});
      if (route === `GET /api/session/${SESSION}/inbox`) return json([]);
      if (route === `GET /api/session/${SESSION}/message`) {
        // Idle once nothing waits for an answer any more.
        const settled = stub.permissions.length === 0 && stub.forms.length === 0;
        return json(url.searchParams.get("limit") === "1" || !settled ? [] : [{ id: "msg_9", type: "idle" }]);
      }
      if (route === "GET /api/permission/request") return json(stub.permissions);
      if (route === "GET /api/form") return json(stub.forms);
      const permission = /^POST \/api\/session\/[^/]+\/permission\/([^/]+)\/reply$/.exec(route);
      if (permission) {
        const response = status(stub.permissionReplies);
        stub.log.push(`permission reply ${response.status}`);
        if (response.ok) stub.permissions = stub.permissions.filter((item) => item.id !== permission[1]);
        return response;
      }
      const reply = /^POST \/api\/session\/[^/]+\/form\/([^/]+)\/reply$/.exec(route);
      if (reply) {
        const response = status(stub.formReplies);
        stub.log.push(`form reply ${response.status}`);
        if (response.ok) stub.forms = stub.forms.filter((item) => item.id !== reply[1]);
        return response;
      }
      const cancel = /^DELETE \/api\/session\/[^/]+\/form\/([^/]+)$/.exec(route);
      if (cancel) {
        const response = status(stub.formCancels);
        stub.log.push(`form cancel ${response.status}${url.searchParams.get("message") ? " with a message" : ""}`);
        if (response.ok) stub.forms = stub.forms.filter((item) => item.id !== cancel[1]);
        return response;
      }
      return new Response(`no route ${route}`, { status: 404 });
    },
  });
  return new Api(`http://127.0.0.1:${server.port}`, "password", "/project");
}

const permission: PermissionRequest = { id: "per_1", sessionID: SESSION, action: "shell", resources: ["ls"] };
const form: FormRequest = { id: "frm_1", sessionID: SESSION, fields: [{ key: "q0", type: "string", description: "Which?", options: [{ value: "a", label: "A" }] }] };

async function drive(stub: Stub) {
  const api = serve(stub);
  const permissions: PermissionRecord[] = [];
  const questions: QuestionRecord[] = [];
  const result = await driveTurn({
    api,
    sessionID: SESSION,
    turn: { kind: "prompt", text: "go" },
    agent: "lead",
    policy: DEFAULT_POLICY,
    deadline: Date.now() + 20_000,
    permissions,
    questions,
    executions: new Executions(),
    pollMs: 10,
  });
  return { result, permissions, questions };
}

describe("answering requests", () => {
  test("a permission reply that failed is tried again and recorded once, when it succeeds", async () => {
    const stub: Stub = { permissions: [permission], forms: [], permissionReplies: [500, 500], formReplies: [], formCancels: [], log: [] };
    const { result, permissions } = await drive(stub);
    expect(result.status).toBe("completed");
    expect(stub.log).toEqual(["permission reply 500", "permission reply 500", "permission reply 204"]);
    expect(permissions.map((item) => [item.id, item.reply])).toEqual([["per_1", "once"]]);
  });

  test("a form whose reply failed is cancelled, and tried again while the cancel fails too", async () => {
    const stub: Stub = { permissions: [], forms: [form], permissionReplies: [], formReplies: [400, 400], formCancels: [500], log: [] };
    const { result, questions } = await drive(stub);
    expect(result.status).toBe("completed");
    expect(stub.log).toEqual(["form reply 400", "form cancel 500 with a message", "form reply 400", "form cancel 204 with a message"]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: "frm_1", answers: [], cancelled: true });
  });

  test("a form answered at once is recorded with its answers", async () => {
    const stub: Stub = { permissions: [], forms: [form], permissionReplies: [], formReplies: [], formCancels: [], log: [] };
    const { questions } = await drive(stub);
    expect(stub.log).toEqual(["form reply 204"]);
    expect(questions[0]).toMatchObject({ id: "frm_1", answers: [["A"]] });
    expect(questions[0]!.cancelled).toBeUndefined();
  });
});
