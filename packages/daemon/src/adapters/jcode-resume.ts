import type { ResumeResult } from "./claude-resume.js";
import { JcodeRuntimeAdapter } from "./jcode-runtime-adapter.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";

export { type ResumeResult };

/** Legacy restore uses the same per-seat server and readiness checks as pod restore. */
export class JcodeResumeAdapter {
  constructor(private runtimeAdapter: JcodeRuntimeAdapter) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "jcode_id" && !!resumeToken;
  }

  async resume(sessionName: string, resumeType: string | null, resumeToken: string | null,
    cwd: string, model?: string | null): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Jcode resume requires a session id" };
    }
    const binding: NodeBinding = {
      id: "", nodeId: "", tmuxSession: sessionName, tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
      model: model ?? undefined,
    };
    const result = await this.runtimeAdapter.launchHarness(binding, { name: sessionName, resumeToken: resumeToken! });
    if (result.ok) return { ok: true, appliedLaunch: result.appliedLaunch };
    return {
      ok: false,
      code: result.recovery === "retry_fresh" ? "retry_fresh"
        : result.recovery === "attention_required" ? "attention_required" : "resume_failed",
      message: result.error,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    };
  }
}
