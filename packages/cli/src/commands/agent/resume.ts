import { type Command } from "commander";
import type { AgentPersistenceHandle } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent resume command */
export interface AgentResumeResult {
  agentId: string;
  status: "resumed" | "completed" | "timeout" | "permission" | "error";
  provider: string;
  cwd: string;
  title: string | null;
}

/** Schema for agent resume output */
export const agentResumeSchema: OutputSchema<AgentResumeResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "CWD", field: "cwd", width: 30 },
    { header: "TITLE", field: "title", width: 20 },
  ],
};

export interface AgentResumeOptions extends CommandOptions {
  provider?: string;
  cwd?: string;
  model?: string;
  detach?: boolean;
  waitTimeout?: string;
}

export function addResumeOptions(cmd: Command): Command {
  return cmd
    .description("Resume an existing Claude Code session by its session ID")
    .argument("<session-id>", "Claude Code session ID to resume")
    .argument("[prompt]", "Optional follow-up prompt to send after resuming")
    .option("--provider <provider>", "Agent provider (default: claude)", "claude")
    .option("--cwd <path>", "Working directory (must match original session)")
    .option("--model <model>", "Model override for the resumed session")
    .option("-d, --detach", "Resume in background (detached)")
    .option(
      "--wait-timeout <duration>",
      "Maximum time to wait for agent to finish (e.g., 30s, 5m, 1h). Default: no limit",
    );
}

export async function runResumeCommand(
  sessionId: string,
  prompt: string | undefined,
  options: AgentResumeOptions,
  _command: Command,
): Promise<SingleResult<AgentResumeResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  if (!sessionId || sessionId.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_SESSION_ID",
      message: "A session ID is required",
      details:
        "Usage: paseo resume <session-id> [prompt]\n" +
        "Find session IDs in ~/.claude/projects/ or via `paseo inspect <agent-id>`",
    };
    throw error;
  }

  const cwd = options.cwd ?? process.cwd();
  const provider = options.provider?.trim() || "claude";

  let waitTimeoutMs = 0;
  if (options.waitTimeout) {
    const { parseDuration } = await import("../../utils/duration.js");
    try {
      waitTimeoutMs = parseDuration(options.waitTimeout);
      if (waitTimeoutMs <= 0) {
        throw new Error("Timeout must be positive");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: CommandError = {
        code: "INVALID_TIMEOUT",
        message: "Invalid wait timeout value",
        details: message,
      };
      throw error;
    }
  }

  let client;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    // Build the persistence handle for the external session
    const handle: AgentPersistenceHandle = {
      provider,
      sessionId: sessionId.trim(),
      nativeHandle: sessionId.trim(),
      metadata: { cwd },
    };

    // Build config overrides
    const overrides: Record<string, unknown> = { cwd };
    if (options.model) {
      overrides.model = options.model.trim();
    }

    // Resume the agent via the existing daemon protocol
    const agent = await client.resumeAgent(handle, overrides);

    // Send a follow-up prompt if provided
    if (prompt && prompt.trim().length > 0) {
      await client.sendAgentMessage(agent.id, prompt.trim());
    }

    // If detached, return immediately
    if (options.detach || (!prompt?.trim())) {
      await client.close();

      return {
        type: "single",
        data: {
          agentId: agent.id,
          status: "resumed",
          provider: agent.provider,
          cwd: agent.cwd,
          title: agent.title,
        },
        schema: agentResumeSchema,
      };
    }

    // Wait for the agent to finish processing the prompt
    const state = await client.waitForFinish(agent.id, waitTimeoutMs);
    await client.close();

    const finalAgent = state.final ?? agent;
    const status: AgentResumeResult["status"] =
      state.status === "idle" ? "completed" : (state.status as AgentResumeResult["status"]);

    return {
      type: "single",
      data: {
        agentId: finalAgent.id,
        status,
        provider: finalAgent.provider,
        cwd: finalAgent.cwd,
        title: finalAgent.title,
      },
      schema: agentResumeSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "AGENT_RESUME_FAILED",
      message: `Failed to resume session: ${message}`,
      details:
        "Ensure the session ID is valid and the working directory matches the original session.\n" +
        "Session files are stored in ~/.claude/projects/",
    };
    throw error;
  }
}
