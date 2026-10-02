import { describe, expect, it } from 'vitest';
import { WorkflowGraph } from '../src/engine/graph.ts';
import { stage } from './harness.ts';

const graph = (...stages: ReturnType<typeof stage>[]) => new WorkflowGraph({ id: 'w', stages });

describe('WorkflowGraph', () => {
  it('orders stages so every stage comes after its dependencies', () => {
    const g = graph(
      stage('d', { dependsOn: ['b', 'c'] }),
      stage('b', { dependsOn: ['a'] }),
      stage('c', { dependsOn: ['a'] }),
      stage('a'),
    );
    expect(g.order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('computes ancestors and descendants transitively', () => {
    const g = graph(stage('a'), stage('b', { dependsOn: ['a'] }), stage('c', { dependsOn: ['b'] }), stage('x'));
    expect([...g.ancestors('c')].sort()).toEqual(['a', 'b']);
    expect([...g.descendants('a')].sort()).toEqual(['b', 'c']);
    expect([...g.descendants('x')]).toEqual([]);
  });

  it('rejects a dependency cycle', () => {
    expect(() => graph(stage('a', { dependsOn: ['b'] }), stage('b', { dependsOn: ['a'] }))).toThrowError(/cycle/);
  });

  it('rejects a dependency on a stage that does not exist', () => {
    expect(() => graph(stage('a', { dependsOn: ['ghost'] }))).toThrowError(/unknown stage "ghost"/);
  });

  it('rejects duplicate stage ids', () => {
    expect(() => graph(stage('a'), stage('a'))).toThrowError(/Duplicate stage id/);
  });

  it('rejects two stages producing the same artifact', () => {
    expect(() => graph(stage('a', { produces: ['x'] }), stage('b', { produces: ['x'] }))).toThrowError(/produced by both/);
  });

  it('rejects consuming an artifact from a stage that is not a dependency', () => {
    expect(() => graph(stage('a'), stage('b', { consumes: ['a-out'] }))).toThrowError(/not one of its dependencies/);
  });

  it('allows consuming an artifact that no stage produces, because it is supplied from outside', () => {
    expect(() => graph(stage('a', { consumes: ['requirement'] }))).not.toThrowError();
  });

  it('rejects a rework loop whose feedback nobody upstream consumes', () => {
    expect(() =>
      graph(stage('build'), stage('verify', { dependsOn: ['build'], rework: { feedbackArtifact: 'feedback', max: 1 } })),
    ).toThrowError(/no upstream stage consumes it/);
  });
});
