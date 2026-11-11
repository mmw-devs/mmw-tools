/**
 * Contract gate for `pr_merge`.
 *
 * The ops repository declares which operations may be merged by an agent in
 * `contract/operations.json` (generated view: `COMMANDS.md`). Each level
 * carries `agentMerge`; today L2 is `true` and L1/L3 are `false`.
 *
 * The host prompt already asks the human before a merge. This gate is the
 * second half: even with consent, a PR whose op-log declares an
 * `agentMerge: false` command must not be merged by the agent. The refusal is
 * derived from the repository's own contract, not from a copy of the rule in
 * this plugin, so a level change in the contract takes effect here without a
 * code change.
 *
 * Repositories without `contract/operations.json` are unaffected: the gate
 * has no contract to read and lets the merge proceed.
 *
 * Both functions below are pure so the decision can be tested without GitHub.
 */
/**
 * Extract every `command` declared in an op-log JSON block.
 *
 * The ops convention fences the log as ````` ````json ```` ``` (four
 * backticks, because the log itself may quote Markdown). Three or more
 * backticks/tildes are accepted; blocks that fail to parse are skipped —
 * a malformed block cannot name a command, and the contract check fails
 * closed for "no command found" instead.
 */
export function extractCommands(message) {
    const ids = [];
    if (typeof message !== "string" || message.length === 0)
        return ids;
    const fence = /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/g;
    let match;
    while ((match = fence.exec(message)) !== null) {
        let parsed;
        try {
            parsed = JSON.parse(match[2]);
        }
        catch {
            continue;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
        const command = parsed.command;
        if (typeof command === "string" && command.trim() !== "")
            ids.push(command.trim());
    }
    return ids;
}
/** command id → level id, from the contract's domain tables. */
export function levelIndex(contract) {
    const index = new Map();
    for (const domain of contract.domains ?? []) {
        for (const command of domain.commands ?? []) {
            if (typeof command.id === "string" && typeof command.level === "string") {
                index.set(command.id, command.level);
            }
        }
    }
    return index;
}
/**
 * Decide whether the agent may merge a PR that declares `commandIds`.
 *
 * Rules, all fail-closed:
 *   - no command in any op-log        → refuse (cannot prove the level);
 *   - command absent from the contract → refuse (unknown operation);
 *   - level without `agentMerge`       → refuse (incomplete contract);
 *   - any `agentMerge !== true`        → refuse (L1/L3, or an explicit opt-out);
 *   - otherwise                        → allow.
 */
export function evaluateMergeContract(contract, commandIds) {
    if (commandIds.length === 0) {
        return {
            allowed: false,
            reason: "PR 提交信息里没有 op-log 的 command 字段，无法确认操作级别",
        };
    }
    const index = levelIndex(contract);
    const levels = contract.levels ?? {};
    for (const id of commandIds) {
        const level = index.get(id);
        if (!level) {
            return {
                allowed: false,
                reason: `command ${JSON.stringify(id)} 不在 contract/operations.json 中`,
            };
        }
        const definition = levels[level];
        if (!definition || typeof definition.agentMerge !== "boolean") {
            return {
                allowed: false,
                reason: `契约没有为级别 ${JSON.stringify(level)} 声明 agentMerge`,
            };
        }
        if (definition.agentMerge !== true) {
            return {
                allowed: false,
                reason: `command ${JSON.stringify(id)} 属于 ${level}，agentMerge=false —— 该级别只能由人工在 PR 平台合并`,
            };
        }
    }
    return { allowed: true, reason: "" };
}
