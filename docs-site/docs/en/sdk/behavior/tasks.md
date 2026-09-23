# Tasks

Tasks track work and its execution results with four tools: `TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList`. They are enabled by default and stored under the project's SDK data directory.

## Scope

Each session has its own list. Children share their parent's list. To share deliberately across sessions, set `taskListId` (or `LITE_AGENT_TASK_LIST_ID`). Existing lists named `default` can be reopened with `taskListId: "default"`. Set `tasks: false` to disable task tracking and reminders.

## States and execution

| State | Meaning |
| --- | --- |
| `pending` | Not started; dependencies may still block it. |
| `in_progress` | Being worked on. |
| `review` | Child execution succeeded; its result still needs verification. |
| `completed` | The task's goal has been checked and met. |
| `failed` | Execution failed; inspect its result before retrying. |
| `cancelled` | Execution was cancelled. |

An `Agent` dispatch automatically creates a task. Pass `task_id` to associate an existing task instead. Its `owner` and `execution.agentId` identify the child, and `execution.result` retains the result or error. One task can have only one active child; the model cannot mark it complete while that child is running. After a successful child run, inspect the result with `TaskGet` and use `TaskUpdate` to accept it as `completed`.

`TaskUpdate` can edit task fields and add `blockedBy`/`blocks` edges. Cycles are rejected. Unfinished prerequisites prevent a task from entering `in_progress`, `review`, or `completed`. Dependencies do not automatically schedule work: the parent chooses when to dispatch a ready task.

Task writes use a file lock and atomic file replacement. They survive restarts, but active child execution does not resume automatically after a process crash. Inspect any stale `in_progress` task before recovery; persisted task state is not a durable job scheduler.

## Model reminders and UI

The per-turn reminder includes active, review, and failed work; completed and cancelled tasks are omitted. `TaskList` still returns the whole list. Reminders are not persisted as conversation messages. Subscribe to `task_update` for state changes and `model_call_start` for the actual model and requested reasoning effort.

```ts
const agent = createLiteAgent({ model, workdir });
const unsubscribe = agent.subscribe(({ event }) => {
  if (event.type === "task_update") console.log(event.taskId, event.status);
});
try {
  await agent.send("Delegate two independent checks and verify their results.");
  await agent.awaitIdle();
} finally {
  unsubscribe();
  await agent.close();
}
```
