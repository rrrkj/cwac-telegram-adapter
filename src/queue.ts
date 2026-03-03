import { v4 as uuidv4 } from 'uuid';
import { Task, TaskResult, AgentType, TaskStatus as TStatus } from './types';
import pino from 'pino';

const logger = pino({ name: 'queue' });

type TaskCallback = (task: Task) => void;
type ResultCallback = (result: TaskResult) => void;

/**
 * In-memory task queue.
 * Copied from connect-with-all-code's queue.ts — identical logic.
 */
class TaskQueue {
    private queue: Task[] = [];
    private results = new Map<string, TaskResult>();
    private history: Task[] = [];
    private onTask: TaskCallback | null = null;
    private onResult: ResultCallback | null = null;
    private activeTask: Task | null = null;

    onTaskReady(callback: TaskCallback): void {
        this.onTask = callback;
    }

    onTaskResult(callback: ResultCallback): void {
        this.onResult = callback;
    }

    enqueue(agent: AgentType, prompt: string, workspace: string, userId: string): Task {
        const task: Task = {
            id: uuidv4(),
            agent,
            prompt,
            workspace,
            userId,
            status: 'queued',
            createdAt: Date.now(),
        };

        this.queue.push(task);
        this.history.push(task);
        logger.info({ taskId: task.id, agent, userId }, 'Task enqueued');
        this.processNext();
        return task;
    }

    private processNext(): void {
        if (this.activeTask || this.queue.length === 0) return;

        this.activeTask = this.queue.shift()!;
        this.activeTask.status = 'running';
        logger.info({ taskId: this.activeTask.id }, 'Dispatching task');

        if (this.onTask) {
            this.onTask(this.activeTask);
        }
    }

    completeTask(result: TaskResult): void {
        this.results.set(result.taskId, result);

        const task = this.history.find((t) => t.id === result.taskId);
        if (task) {
            task.status = result.status;
        }

        if (this.activeTask?.id === result.taskId) {
            this.activeTask = null;
        }

        logger.info({ taskId: result.taskId, status: result.status }, 'Task completed');

        if (this.onResult) {
            this.onResult(result);
        }

        this.processNext();
    }

    cancelActive(): Task | null {
        if (!this.activeTask) return null;

        const cancelled = this.activeTask;
        cancelled.status = 'cancelled';
        this.activeTask = null;
        logger.info({ taskId: cancelled.id }, 'Task cancelled');
        this.processNext();
        return cancelled;
    }

    getHistory(userId: string, limit: number = 10): Task[] {
        return this.history
            .filter((t) => t.userId === userId)
            .slice(-limit)
            .reverse();
    }

    getActiveTask(): Task | null {
        return this.activeTask;
    }
}

export const taskQueue = new TaskQueue();
