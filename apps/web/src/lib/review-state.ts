import type { AuthConfigView, AuthMode } from './api-types';
import type { BuilderEntity } from './builder';
import { configForChoice } from './auth-onboarding';
import type { FieldPathIndex } from './error-paths';
import { attachDescriptions, serializeBuilder, type ReviewSource } from './builder-payload';

export type ReviewState = ReviewSource;

export type ReviewAction =
  | { type: 'load'; state: ReviewState }
  | { type: 'name'; value: string }
  | { type: 'description'; value: string }
  | { type: 'kind'; value: 'project' | 'single' }
  | { type: 'entity'; id: string; next: BuilderEntity }
  | { type: 'addEntity'; entity: BuilderEntity }
  | { type: 'removeEntity'; id: string }
  | { type: 'methods'; value: string[] }
  | { type: 'mockRecords'; value: number }
  | { type: 'authMode'; value: AuthMode }
  | { type: 'toggleProtected'; name: string };

export function hasRelations(state: ReviewState): boolean {
  return state.entities.some((entity) => entity.relations.length > 0);
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'load':
      return action.state;
    case 'name':
      return { ...state, name: action.value };
    case 'description':
      return { ...state, description: action.value };
    case 'kind': {
      if (action.value === state.kind) return state;
      if (action.value === 'project') return { ...state, kind: 'project' };
      // A Single API has no relations, and its auth question has no "some of it" answer.
      const combination = state.authMode === 'COMBINATION';
      return {
        ...state,
        kind: 'single',
        entities: state.entities.map((entity) => ({ ...entity, relations: [] })),
        authMode: combination ? null : state.authMode,
        protectedNames: combination ? [] : state.protectedNames,
      };
    }
    case 'entity': {
      const previous = state.entities.find((entity) => entity.id === action.id);
      const renamed = previous && previous.name !== action.next.name ? previous.name : null;
      return {
        ...state,
        entities: state.entities.map((entity) => (entity.id === action.id ? action.next : entity)),
        protectedNames: renamed
          ? state.protectedNames.map((name) => (name === renamed ? action.next.name : name))
          : state.protectedNames,
      };
    }
    case 'addEntity':
      return { ...state, entities: [...state.entities, action.entity] };
    case 'removeEntity': {
      const gone = state.entities.find((entity) => entity.id === action.id);
      return {
        ...state,
        entities: state.entities.filter((entity) => entity.id !== action.id),
        protectedNames: gone
          ? state.protectedNames.filter((name) => name !== gone.name)
          : state.protectedNames,
      };
    }
    case 'methods':
      return { ...state, methods: action.value };
    case 'mockRecords':
      return { ...state, mockRecords: action.value };
    case 'authMode':
      // Selections survive a mode change, as in the wizard.
      return { ...state, authMode: action.value };
    case 'toggleProtected':
      return {
        ...state,
        protectedNames: state.protectedNames.includes(action.name)
          ? state.protectedNames.filter((name) => name !== action.name)
          : [...state.protectedNames, action.name],
      };
  }
}

export interface AiDraftInput {
  kind: 'project' | 'single';
  name: string;
  description: string;
  entities: Record<string, unknown>[];
  generationConfig: { methods: string[]; mockRecords: number };
  authAnswered: boolean;
  authentication: AuthConfigView | null;
}

/**
 * The PATCH/adopt body for the current form, plus the path index that maps the
 * server's issues back onto fields. The auth config is recomputed from the mode
 * (never read back off the payload), so this file needs no raw auth read.
 */
export function draftInputFor(
  state: ReviewState,
  described: readonly { name: string; description?: string }[],
): { input: AiDraftInput; pathIndex: FieldPathIndex } {
  const generationConfig = { methods: state.methods, mockRecords: state.mockRecords };
  const { raw, pathIndex } = serializeBuilder({
    entities: state.entities,
    generationConfig,
    authMode: state.authMode ?? 'NONE',
    protectedNames: state.protectedNames,
  });
  return {
    input: {
      kind: state.kind,
      name: state.name,
      description: state.description,
      entities: attachDescriptions(raw.entities, described),
      generationConfig,
      authAnswered: state.authMode !== null,
      authentication: state.authMode === null ? null : configForChoice(state.authMode),
    },
    pathIndex,
  };
}

/** A translation replaces the description only if the user has not edited it. */
export function applyTranslation(
  state: ReviewState,
  previousDescription: string,
  nextDescription: string,
): ReviewState {
  return state.description === previousDescription
    ? { ...state, description: nextDescription }
    : state;
}
