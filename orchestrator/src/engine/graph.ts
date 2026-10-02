import type { StageDefinition, WorkflowDefinition } from './types.ts';

/**
 * The validated dependency graph of a workflow.
 * Construction fails on anything that would make execution ambiguous or unsafe, so those mistakes
 * surface when the workflow is defined rather than halfway through a run.
 */
export class WorkflowGraph {
  readonly id: string;
  readonly order: string[];
  private readonly byId = new Map<string, StageDefinition>();
  private readonly children = new Map<string, string[]>();

  constructor(workflow: WorkflowDefinition) {
    this.id = workflow.id;

    for (const stage of workflow.stages) {
      if (this.byId.has(stage.id)) throw new Error(`Duplicate stage id "${stage.id}".`);
      this.byId.set(stage.id, stage);
      this.children.set(stage.id, []);
    }
    for (const stage of workflow.stages) {
      for (const dependency of stage.dependsOn) {
        if (!this.byId.has(dependency)) {
          throw new Error(`Stage "${stage.id}" depends on unknown stage "${dependency}".`);
        }
        this.children.get(dependency)!.push(stage.id);
      }
    }

    this.order = this.topologicalOrder(workflow.stages);
    this.checkArtifacts(workflow.stages);
    this.checkReworkTargets(workflow.stages);
  }

  stage(id: string): StageDefinition {
    const stage = this.byId.get(id);
    if (!stage) throw new Error(`Unknown stage "${id}".`);
    return stage;
  }

  get stages(): StageDefinition[] {
    return this.order.map((id) => this.stage(id));
  }

  /** Every stage reachable by following dependencies upwards. */
  ancestors(id: string): Set<string> {
    const seen = new Set<string>();
    const visit = (current: string): void => {
      for (const dependency of this.stage(current).dependsOn) {
        if (!seen.has(dependency)) {
          seen.add(dependency);
          visit(dependency);
        }
      }
    };
    visit(id);
    return seen;
  }

  /** Every stage that depends on this one, directly or indirectly. */
  descendants(id: string): Set<string> {
    const seen = new Set<string>();
    const visit = (current: string): void => {
      for (const child of this.children.get(current) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          visit(child);
        }
      }
    };
    visit(id);
    return seen;
  }

  /** Kahn's algorithm. Ties keep declaration order, so the order is stable from run to run. */
  private topologicalOrder(stages: StageDefinition[]): string[] {
    const remaining = new Map(stages.map((stage) => [stage.id, stage.dependsOn.length]));
    const order: string[] = [];
    const ready = stages.filter((stage) => stage.dependsOn.length === 0).map((stage) => stage.id);

    while (ready.length > 0) {
      const id = ready.shift()!;
      order.push(id);
      for (const child of this.children.get(id) ?? []) {
        const left = remaining.get(child)! - 1;
        remaining.set(child, left);
        if (left === 0) ready.push(child);
      }
    }
    if (order.length !== stages.length) {
      const stuck = stages.filter((stage) => !order.includes(stage.id)).map((stage) => stage.id);
      throw new Error(`Workflow has a dependency cycle involving: ${stuck.join(', ')}.`);
    }
    return order;
  }

  /** A required input must be produced by an ancestor, or supplied from outside the graph at run creation. */
  private checkArtifacts(stages: StageDefinition[]): void {
    const producer = new Map<string, string>();
    for (const stage of stages) {
      for (const artifact of stage.produces) {
        const existing = producer.get(artifact);
        if (existing) {
          throw new Error(`Artifact "${artifact}" is produced by both "${existing}" and "${stage.id}".`);
        }
        producer.set(artifact, stage.id);
      }
    }
    for (const stage of stages) {
      const ancestors = this.ancestors(stage.id);
      for (const artifact of stage.consumes) {
        const from = producer.get(artifact);
        if (from !== undefined && !ancestors.has(from)) {
          throw new Error(
            `Stage "${stage.id}" consumes "${artifact}" from "${from}", which is not one of its dependencies.`,
          );
        }
      }
    }
  }

  /** Feedback from a failed gate must reach a stage that runs before the failing one, or the loop cannot converge. */
  private checkReworkTargets(stages: StageDefinition[]): void {
    for (const stage of stages) {
      if (!stage.rework) continue;
      const ancestors = this.ancestors(stage.id);
      const consumer = stages.find(
        (candidate) =>
          ancestors.has(candidate.id) &&
          (candidate.consumesOptional ?? []).includes(stage.rework!.feedbackArtifact),
      );
      if (!consumer) {
        throw new Error(
          `Stage "${stage.id}" sends feedback as "${stage.rework.feedbackArtifact}", but no upstream stage consumes it.`,
        );
      }
    }
  }
}
