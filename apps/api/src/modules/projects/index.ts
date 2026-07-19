/** Projects module barrel. */
export * from './schema.ts';
export {
  createProjectsService,
  toProjectDto,
  ProjectNotFoundError,
  StageNotConfiguredError,
  type AnimationStagePort,
  type CreateProjectInput,
  type ImageStagePort,
  type PreviewGatePort,
  type ProjectRecord,
  type ProjectsRepository,
  type ProjectsService,
  type RenderStagePort,
} from './service.ts';
export {
  createDbProjectsRepository,
  createInMemoryProjectsRepository,
} from './repository.ts';
export { createDbImageStage } from './image-stage.ts';
export { createDbPreviewGate } from './preview-gate.ts';
export { createDbRenderStage } from './render-stage.ts';
export { createDbAnimationStage } from './animation-stage.ts';
export { projectsRoutes, projectsMcpRoutes } from './routes.ts';
export * from './fsm.ts';
