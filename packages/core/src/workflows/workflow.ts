import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import { TransformStream } from 'node:stream/web';
import { z } from 'zod';
import type { Mastra, WorkflowRun } from '..';
import type { MastraPrimitives } from '../action';
import { Agent } from '../agent';
import type { TracingContext } from '../ai-tracing';
import { MastraBase } from '../base';
import { RuntimeContext } from '../di';
import { RegisteredLogger } from '../logger';
import type { MastraScorers } from '../scores';
import { MastraWorkflowStream } from '../stream/MastraWorkflowStream';
import type { ChunkType } from '../stream/types';
import { ChunkFrom } from '../stream/types';
import { Tool } from '../tools';
import type { ToolExecutionContext } from '../tools/types';
import type { DynamicArgument } from '../types';
import { EMITTER_SYMBOL, STREAM_FORMAT_SYMBOL } from './constants';
import { DefaultExecutionEngine } from './default';
import type { ExecutionEngine, ExecutionGraph } from './execution-engine';
import type { ExecuteFunction, Step } from './step';
import type {
  DefaultEngineType,
  DynamicMapping,
  ExtractSchemaFromStep,
  ExtractSchemaType,
  PathsToStringProps,
  SerializedStep,
  SerializedStepFlowEntry,
  StepFlowEntry,
  StepResult,
  StepsRecord,
  StepWithComponent,
  StreamEvent,
  WatchEvent,
  WorkflowConfig,
  WorkflowResult,
  WorkflowRunState,
} from './types';

export function mapVariable<TStep extends Step<string, any, any, any, any, any>>({
  step,
  path,
}: {
  step: TStep;
  path: PathsToStringProps<ExtractSchemaType<ExtractSchemaFromStep<TStep, 'outputSchema'>>> | '.';
}): {
  step: TStep;
  path: PathsToStringProps<ExtractSchemaType<ExtractSchemaFromStep<TStep, 'outputSchema'>>> | '.';
};
export function mapVariable<TWorkflow extends Workflow<any, any, any, any, any, any>>({
  initData: TWorkflow,
  path,
}: {
  initData: TWorkflow;
  path: PathsToStringProps<ExtractSchemaType<ExtractSchemaFromStep<TWorkflow, 'inputSchema'>>> | '.';
}): {
  initData: TWorkflow;
  path: PathsToStringProps<ExtractSchemaType<ExtractSchemaFromStep<TWorkflow, 'inputSchema'>>> | '.';
};
export function mapVariable(config: any): any {
  return config;
}

type StepParams<
  TStepId extends string,
  TStepInput extends z.ZodType<any>,
  TStepOutput extends z.ZodType<any>,
  TResumeSchema extends z.ZodType<any>,
  TSuspendSchema extends z.ZodType<any>,
> = {
  id: TStepId;
  description?: string;
  inputSchema: TStepInput;
  outputSchema: TStepOutput;
  resumeSchema?: TResumeSchema;
  suspendSchema?: TSuspendSchema;
  retries?: number;
  scorers?: DynamicArgument<MastraScorers>;
  execute: ExecuteFunction<
    z.infer<TStepInput>,
    z.infer<TStepOutput>,
    z.infer<TResumeSchema>,
    z.infer<TSuspendSchema>,
    DefaultEngineType
  >;
};

type ToolStep<
  TSchemaIn extends z.ZodType<any>,
  TSchemaOut extends z.ZodType<any>,
  TContext extends ToolExecutionContext<TSchemaIn>,
> = Tool<TSchemaIn, TSchemaOut, TContext> & {
  inputSchema: TSchemaIn;
  outputSchema: TSchemaOut;
  execute: (context: TContext) => Promise<any>;
};

/**
 * Creates a new workflow step
 * @param params Configuration parameters for the step
 * @param params.id Unique identifier for the step
 * @param params.description Optional description of what the step does
 * @param params.inputSchema Zod schema defining the input structure
 * @param params.outputSchema Zod schema defining the output structure
 * @param params.execute Function that performs the step's operations
 * @returns A Step object that can be added to the workflow
 */
export function createStep<
  TStepId extends string,
  TStepInput extends z.ZodType<any>,
  TStepOutput extends z.ZodType<any>,
  TResumeSchema extends z.ZodType<any>,
  TSuspendSchema extends z.ZodType<any>,
>(
  params: StepParams<TStepId, TStepInput, TStepOutput, TResumeSchema, TSuspendSchema>,
): Step<TStepId, TStepInput, TStepOutput, TResumeSchema, TSuspendSchema, DefaultEngineType>;

export function createStep<
  TStepId extends string,
  TStepInput extends z.ZodObject<{ prompt: z.ZodString }>,
  TStepOutput extends z.ZodObject<{ text: z.ZodString }>,
  TResumeSchema extends z.ZodType<any>,
  TSuspendSchema extends z.ZodType<any>,
>(
  agent: Agent<TStepId, any, any>,
): Step<TStepId, TStepInput, TStepOutput, TResumeSchema, TSuspendSchema, DefaultEngineType>;

export function createStep<
  TSchemaIn extends z.ZodType<any>,
  TSchemaOut extends z.ZodType<any>,
  TContext extends ToolExecutionContext<TSchemaIn>,
>(
  tool: ToolStep<TSchemaIn, TSchemaOut, TContext>,
): Step<string, TSchemaIn, TSchemaOut, z.ZodType<any>, z.ZodType<any>, DefaultEngineType>;

export function createStep<
  TStepId extends string,
  TStepInput extends z.ZodType<any>,
  TStepOutput extends z.ZodType<any>,
  TResumeSchema extends z.ZodType<any>,
  TSuspendSchema extends z.ZodType<any>,
>(
  params:
    | StepParams<TStepId, TStepInput, TStepOutput, TResumeSchema, TSuspendSchema>
    | Agent<any, any, any>
    | ToolStep<TStepInput, TStepOutput, any>,
): Step<TStepId, TStepInput, TStepOutput, TResumeSchema, TSuspendSchema, DefaultEngineType> {
  if (params instanceof Agent) {
    return {
      id: params.name,
      // @ts-ignore
      inputSchema: z.object({
        prompt: z.string(),
        // resourceId: z.string().optional(),
        // threadId: z.string().optional(),
      }),
      // @ts-ignore
      outputSchema: z.object({
        text: z.string(),
      }),
      execute: async ({
        inputData,
        [EMITTER_SYMBOL]: emitter,
        [STREAM_FORMAT_SYMBOL]: streamFormat,
        runtimeContext,
        abortSignal,
        abort,
      }) => {
        let streamPromise = {} as {
          promise: Promise<string>;
          resolve: (value: string) => void;
          reject: (reason?: any) => void;
        };

        streamPromise.promise = new Promise((resolve, reject) => {
          streamPromise.resolve = resolve;
          streamPromise.reject = reject;
        });
        const toolData = {
          name: params.name,
          args: inputData,
        };
        await emitter.emit('watch-v2', {
          type: 'workflow-agent-call-start',
          from: 'WORKFLOW',
          payload: toolData,
        });
        // TODO: add support for format, if format is undefined use stream, else streamVNext
        let stream: ReadableStream<any>;

        if (streamFormat === 'aisdk') {
          const { fullStream } = await params.stream(inputData.prompt, {
            // resourceId: inputData.resourceId,
            // threadId: inputData.threadId,
            runtimeContext,
            onFinish: result => {
              streamPromise.resolve(result.text);
            },
            abortSignal,
          });

          stream = fullStream as any;
        } else {
          const modelOutput = await params.streamVNext(inputData.prompt, {
            runtimeContext,
            onFinish: result => {
              streamPromise.resolve(result.text);
            },
            // abortSignal,
          });

          stream = modelOutput.fullStream;
        }

        if (abortSignal.aborted) {
          return abort();
        }

        for await (const chunk of stream) {
          await emitter.emit('watch-v2', chunk);
        }

        await emitter.emit('watch-v2', {
          type: 'workflow-agent-call-finish',
          from: 'WORKFLOW',
          payload: toolData,
        });

        return {
          text: await streamPromise.promise,
        };
      },
    };
  }

  if (params instanceof Tool) {
    if (!params.inputSchema || !params.outputSchema) {
      throw new Error('Tool must have input and output schemas defined');
    }

    return {
      // TODO: tool probably should have strong id type
      // @ts-ignore
      id: params.id,
      inputSchema: params.inputSchema,
      outputSchema: params.outputSchema,
      execute: async ({ inputData, mastra, runtimeContext, tracingContext }) => {
        return params.execute({
          context: inputData,
          mastra,
          runtimeContext,
          tracingContext,
        });
      },
    };
  }

  return {
    id: params.id,
    description: params.description,
    inputSchema: params.inputSchema,
    outputSchema: params.outputSchema,
    resumeSchema: params.resumeSchema,
    suspendSchema: params.suspendSchema,
    scorers: params.scorers,
    retries: params.retries,
    execute: params.execute.bind(params),
  };
}

export function cloneStep<TStepId extends string>(
  step: Step<string, any, any, any, any, DefaultEngineType>,
  opts: { id: TStepId },
): Step<TStepId, any, any, any, any, DefaultEngineType> {
  return {
    id: opts.id,
    description: step.description,
    inputSchema: step.inputSchema,
    outputSchema: step.outputSchema,
    execute: step.execute,
    retries: step.retries,
  };
}

export function createWorkflow<
  TWorkflowId extends string = string,
  TInput extends z.ZodType<any> = z.ZodType<any>,
  TOutput extends z.ZodType<any> = z.ZodType<any>,
  TSteps extends Step<string, any, any, any, any, DefaultEngineType>[] = Step<
    string,
    any,
    any,
    any,
    any,
    DefaultEngineType
  >[],
>(params: WorkflowConfig<TWorkflowId, TInput, TOutput, TSteps>) {
  return new Workflow<DefaultEngineType, TSteps, TWorkflowId, TInput, TOutput, TInput>(params);
}

export function cloneWorkflow<
  TWorkflowId extends string = string,
  TInput extends z.ZodType<any> = z.ZodType<any>,
  TOutput extends z.ZodType<any> = z.ZodType<any>,
  TSteps extends Step<string, any, any, any, any, DefaultEngineType>[] = Step<
    string,
    any,
    any,
    any,
    any,
    DefaultEngineType
  >[],
  TPrevSchema extends z.ZodType<any> = TInput,
>(
  workflow: Workflow<DefaultEngineType, TSteps, string, TInput, TOutput, TPrevSchema>,
  opts: { id: TWorkflowId },
): Workflow<DefaultEngineType, TSteps, TWorkflowId, TInput, TOutput, TPrevSchema> {
  const wf: Workflow<DefaultEngineType, TSteps, TWorkflowId, TInput, TOutput, TPrevSchema> = new Workflow({
    id: opts.id,
    inputSchema: workflow.inputSchema,
    outputSchema: workflow.outputSchema,
    steps: workflow.stepDefs,
    mastra: workflow.mastra,
  });

  wf.setStepFlow(workflow.stepGraph);
  wf.commit();
  return wf;
}

export class Workflow<
    TEngineType = any,
    TSteps extends Step<string, any, any, any, any, TEngineType>[] = Step<string, any, any, any, any, TEngineType>[],
    TWorkflowId extends string = string,
    TInput extends z.ZodType<any> = z.ZodType<any>,
    TOutput extends z.ZodType<any> = z.ZodType<any>,
    TPrevSchema extends z.ZodType<any> = TInput,
  >
  extends MastraBase
  implements Step<TWorkflowId, TInput, TOutput, any, any, DefaultEngineType>
{
  public id: TWorkflowId;
  public description?: string | undefined;
  public inputSchema: TInput;
  public outputSchema: TOutput;
  public steps: Record<string, StepWithComponent>;
  public stepDefs?: TSteps;
  protected stepFlow: StepFlowEntry<TEngineType>[];
  protected serializedStepFlow: SerializedStepFlowEntry[];
  protected executionEngine: ExecutionEngine;
  protected executionGraph: ExecutionGraph;
  public retryConfig: {
    attempts?: number;
    delay?: number;
  };

  #mastra?: Mastra;

  #runs: Map<string, Run<TEngineType, TSteps, TInput, TOutput>> = new Map();

  constructor({
    mastra,
    id,
    inputSchema,
    outputSchema,
    description,
    executionEngine,
    retryConfig,
    steps,
  }: WorkflowConfig<TWorkflowId, TInput, TOutput, TSteps>) {
    super({ name: id, component: RegisteredLogger.WORKFLOW });
    this.id = id;
    this.description = description;
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.retryConfig = retryConfig ?? { attempts: 0, delay: 0 };
    this.executionGraph = this.buildExecutionGraph();
    this.stepFlow = [];
    this.serializedStepFlow = [];
    this.#mastra = mastra;
    this.steps = {};
    this.stepDefs = steps;

    if (!executionEngine) {
      // TODO: this should be configured using the Mastra class instance that's passed in
      this.executionEngine = new DefaultExecutionEngine({ mastra: this.#mastra });
    } else {
      this.executionEngine = executionEngine;
    }

    this.#runs = new Map();
  }

  get runs() {
    return this.#runs;
  }

  get mastra() {
    return this.#mastra;
  }

  __registerMastra(mastra: Mastra) {
    this.#mastra = mastra;
    this.executionEngine.__registerMastra(mastra);
  }

  __registerPrimitives(p: MastraPrimitives) {
    if (p.telemetry) {
      this.__setTelemetry(p.telemetry);
    }

    if (p.logger) {
      this.__setLogger(p.logger);
    }
  }

  setStepFlow(stepFlow: StepFlowEntry<TEngineType>[]) {
    this.stepFlow = stepFlow;
  }

  /**
   * Adds a step to the workflow
   * @param step The step to add to the workflow
   * @returns The workflow instance for chaining
   */
  then<TStepInputSchema extends TPrevSchema, TStepId extends string, TSchemaOut extends z.ZodType<any>>(
    step: Step<TStepId, TStepInputSchema, TSchemaOut, any, any, TEngineType>,
  ) {
    this.stepFlow.push({ type: 'step', step: step as any });
    this.serializedStepFlow.push({
      type: 'step',
      step: {
        id: step.id,
        description: step.description,
        component: (step as SerializedStep).component,
        serializedStepFlow: (step as SerializedStep).serializedStepFlow,
      },
    });
    this.steps[step.id] = step;
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TSchemaOut>;
  }

  /**
   * Adds a sleep step to the workflow
   * @param duration The duration to sleep for
   * @returns The workflow instance for chaining
   */
  sleep(duration: number | ExecuteFunction<z.infer<TPrevSchema>, number, any, any, TEngineType>) {
    const id = `sleep_${this.#mastra?.generateId() || randomUUID()}`;

    const opts: StepFlowEntry<TEngineType> =
      typeof duration === 'function'
        ? { type: 'sleep', id, fn: duration }
        : { type: 'sleep', id, duration: duration as number };
    const serializedOpts: SerializedStepFlowEntry =
      typeof duration === 'function'
        ? { type: 'sleep', id, fn: duration.toString() }
        : { type: 'sleep', id, duration: duration as number };

    this.stepFlow.push(opts);
    this.serializedStepFlow.push(serializedOpts);
    this.steps[id] = createStep({
      id,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        return {};
      },
    });
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TPrevSchema>;
  }

  /**
   * Adds a sleep until step to the workflow
   * @param date The date to sleep until
   * @returns The workflow instance for chaining
   */
  sleepUntil(date: Date | ExecuteFunction<z.infer<TPrevSchema>, Date, any, any, TEngineType>) {
    const id = `sleep_${this.#mastra?.generateId() || randomUUID()}`;
    const opts: StepFlowEntry<TEngineType> =
      typeof date === 'function'
        ? { type: 'sleepUntil', id, fn: date }
        : { type: 'sleepUntil', id, date: date as Date };
    const serializedOpts: SerializedStepFlowEntry =
      typeof date === 'function'
        ? { type: 'sleepUntil', id, fn: date.toString() }
        : { type: 'sleepUntil', id, date: date as Date };

    this.stepFlow.push(opts);
    this.serializedStepFlow.push(serializedOpts);
    this.steps[id] = createStep({
      id,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        return {};
      },
    });
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TPrevSchema>;
  }

  waitForEvent<TStepInputSchema extends TPrevSchema, TStepId extends string, TSchemaOut extends z.ZodType<any>>(
    event: string,
    step: Step<TStepId, TStepInputSchema, TSchemaOut, any, any, TEngineType>,
    opts?: {
      timeout?: number;
    },
  ) {
    this.stepFlow.push({ type: 'waitForEvent', event, step: step as any, timeout: opts?.timeout });
    this.serializedStepFlow.push({
      type: 'waitForEvent',
      event,
      step: {
        id: step.id,
        description: step.description,
        component: (step as SerializedStep).component,
        serializedStepFlow: (step as SerializedStep).serializedStepFlow,
      },
      timeout: opts?.timeout,
    });
    this.steps[step.id] = step;
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TSchemaOut>;
  }

  map(
    mappingConfig:
      | {
          [k: string]:
            | {
                step: Step<string, any, any, any, any, TEngineType> | Step<string, any, any, any, any, TEngineType>[];
                path: string;
              }
            | { value: any; schema: z.ZodType<any> }
            | {
                initData: Workflow<TEngineType, any, any, any, any, any>;
                path: string;
              }
            | {
                runtimeContextPath: string;
                schema: z.ZodType<any>;
              }
            | DynamicMapping<TPrevSchema, z.ZodType<any>>;
        }
      | ExecuteFunction<z.infer<TPrevSchema>, any, any, any, TEngineType>,
    stepOptions?: { id?: string | null },
  ): Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, any> {
    // Create an implicit step that handles the mapping
    if (typeof mappingConfig === 'function') {
      // @ts-ignore
      const mappingStep: any = createStep({
        id: stepOptions?.id || `mapping_${this.#mastra?.generateId() || randomUUID()}`,
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: mappingConfig as any,
      });

      this.stepFlow.push({ type: 'step', step: mappingStep as any });
      this.serializedStepFlow.push({
        type: 'step',
        step: {
          id: mappingStep.id,
          mapConfig: mappingConfig.toString(),
        },
      });
      return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, any>;
    }

    const newMappingConfig: Record<string, any> = Object.entries(mappingConfig).reduce(
      (a, [key, mapping]) => {
        const m: any = mapping;
        if (m.value !== undefined) {
          a[key] = m;
        } else if (m.fn !== undefined) {
          a[key] = {
            fn: m.fn.toString(),
            schema: m.schema,
          };
        } else if (m.runtimeContextPath) {
          a[key] = {
            runtimeContextPath: m.runtimeContextPath,
            schema: m.schema,
          };
        } else {
          a[key] = m;
        }
        return a;
      },
      {} as Record<string, any>,
    );

    const mappingStep: any = createStep({
      id: stepOptions?.id || `mapping_${this.#mastra?.generateId() || randomUUID()}`,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async ctx => {
        const { getStepResult, getInitData, runtimeContext } = ctx;

        const result: Record<string, any> = {};
        for (const [key, mapping] of Object.entries(mappingConfig)) {
          const m: any = mapping;

          if (m.value !== undefined) {
            result[key] = m.value;
            continue;
          }

          if (m.fn !== undefined) {
            result[key] = await m.fn(ctx);
            continue;
          }

          if (m.runtimeContextPath) {
            result[key] = runtimeContext.get(m.runtimeContextPath);
            continue;
          }

          const stepResult = m.initData
            ? getInitData()
            : getStepResult(Array.isArray(m.step) ? m.step.find((s: any) => getStepResult(s)) : m.step);

          if (m.path === '.') {
            result[key] = stepResult;
            continue;
          }

          const pathParts = m.path.split('.');
          let value: any = stepResult;
          for (const part of pathParts) {
            if (typeof value === 'object' && value !== null) {
              value = value[part];
            } else {
              throw new Error(`Invalid path ${m.path} in step ${m?.step?.id ?? 'initData'}`);
            }
          }

          result[key] = value;
        }
        return result as z.infer<typeof mappingStep.outputSchema>;
      },
    });

    type MappedOutputSchema = z.ZodType<any>;

    this.stepFlow.push({ type: 'step', step: mappingStep as any });
    this.serializedStepFlow.push({
      type: 'step',
      step: {
        id: mappingStep.id,
        mapConfig: JSON.stringify(newMappingConfig, null, 2),
      },
    });
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, MappedOutputSchema>;
  }

  // TODO: make typing better here
  parallel<TParallelSteps extends Step<string, TPrevSchema, any, any, any, TEngineType>[]>(steps: TParallelSteps) {
    this.stepFlow.push({ type: 'parallel', steps: steps.map(step => ({ type: 'step', step: step as any })) });
    this.serializedStepFlow.push({
      type: 'parallel',
      steps: steps.map(step => ({
        type: 'step',
        step: {
          id: step.id,
          description: step.description,
          component: (step as SerializedStep).component,
          serializedStepFlow: (step as SerializedStep).serializedStepFlow,
        },
      })),
    });
    steps.forEach(step => {
      this.steps[step.id] = step;
    });
    return this as unknown as Workflow<
      TEngineType,
      TSteps,
      TWorkflowId,
      TInput,
      TOutput,
      z.ZodObject<
        {
          [K in keyof StepsRecord<TParallelSteps>]: StepsRecord<TParallelSteps>[K]['outputSchema'];
        },
        any,
        z.ZodTypeAny
      >
    >;
  }

  // TODO: make typing better here
  branch<
    TBranchSteps extends Array<
      [
        ExecuteFunction<z.infer<TPrevSchema>, any, any, any, TEngineType>,
        Step<string, TPrevSchema, any, any, any, TEngineType>,
      ]
    >,
  >(steps: TBranchSteps) {
    this.stepFlow.push({
      type: 'conditional',
      steps: steps.map(([_cond, step]) => ({ type: 'step', step: step as any })),
      // @ts-ignore
      conditions: steps.map(([cond]) => cond),
      serializedConditions: steps.map(([cond, _step]) => ({ id: `${_step.id}-condition`, fn: cond.toString() })),
    });
    this.serializedStepFlow.push({
      type: 'conditional',
      steps: steps.map(([_cond, step]) => ({
        type: 'step',
        step: {
          id: step.id,
          description: step.description,
          component: (step as SerializedStep).component,
          serializedStepFlow: (step as SerializedStep).serializedStepFlow,
        },
      })),
      serializedConditions: steps.map(([cond, _step]) => ({ id: `${_step.id}-condition`, fn: cond.toString() })),
    });
    steps.forEach(([_, step]) => {
      this.steps[step.id] = step;
    });

    // Extract just the Step elements from the tuples array
    type BranchStepsArray = { [K in keyof TBranchSteps]: TBranchSteps[K][1] };

    // This creates a mapped type that extracts the second element from each tuple
    type ExtractedSteps = BranchStepsArray[number];

    // Now we can use this type as an array, similar to TParallelSteps
    return this as unknown as Workflow<
      TEngineType,
      TSteps,
      TWorkflowId,
      TInput,
      TOutput,
      z.ZodObject<
        {
          [K in keyof StepsRecord<ExtractedSteps[]>]: StepsRecord<ExtractedSteps[]>[K]['outputSchema'];
        },
        any,
        z.ZodTypeAny
      >
    >;
  }

  dowhile<TStepInputSchema extends TPrevSchema, TStepId extends string, TSchemaOut extends z.ZodType<any>>(
    step: Step<TStepId, TStepInputSchema, TSchemaOut, any, any, TEngineType>,
    condition: ExecuteFunction<z.infer<TSchemaOut>, any, any, any, TEngineType>,
  ) {
    this.stepFlow.push({
      type: 'loop',
      step: step as any,
      // @ts-ignore
      condition,
      loopType: 'dowhile',
      serializedCondition: { id: `${step.id}-condition`, fn: condition.toString() },
    });
    this.serializedStepFlow.push({
      type: 'loop',
      step: {
        id: step.id,
        description: step.description,
        component: (step as SerializedStep).component,
        serializedStepFlow: (step as SerializedStep).serializedStepFlow,
      },
      serializedCondition: { id: `${step.id}-condition`, fn: condition.toString() },
      loopType: 'dowhile',
    });
    this.steps[step.id] = step;
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TSchemaOut>;
  }

  dountil<TStepInputSchema extends TPrevSchema, TStepId extends string, TSchemaOut extends z.ZodType<any>>(
    step: Step<TStepId, TStepInputSchema, TSchemaOut, any, any, TEngineType>,
    condition: ExecuteFunction<z.infer<TSchemaOut>, any, any, any, TEngineType>,
  ) {
    this.stepFlow.push({
      type: 'loop',
      step: step as any,
      // @ts-ignore
      condition,
      loopType: 'dountil',
      serializedCondition: { id: `${step.id}-condition`, fn: condition.toString() },
    });
    this.serializedStepFlow.push({
      type: 'loop',
      step: {
        id: step.id,
        description: step.description,
        component: (step as SerializedStep).component,
        serializedStepFlow: (step as SerializedStep).serializedStepFlow,
      },
      serializedCondition: { id: `${step.id}-condition`, fn: condition.toString() },
      loopType: 'dountil',
    });
    this.steps[step.id] = step;
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TSchemaOut>;
  }

  foreach<
    TPrevIsArray extends TPrevSchema extends z.ZodArray<any> ? true : false,
    TStepInputSchema extends TPrevSchema extends z.ZodArray<infer TElement> ? TElement : never,
    TStepId extends string,
    TSchemaOut extends z.ZodType<any>,
  >(
    step: TPrevIsArray extends true
      ? Step<TStepId, TStepInputSchema, TSchemaOut, any, any, TEngineType>
      : 'Previous step must return an array type',
    opts?: {
      concurrency: number;
    },
  ) {
    this.stepFlow.push({ type: 'foreach', step: step as any, opts: opts ?? { concurrency: 1 } });
    this.serializedStepFlow.push({
      type: 'foreach',
      step: {
        id: (step as SerializedStep).id,
        description: (step as SerializedStep).description,
        component: (step as SerializedStep).component,
        serializedStepFlow: (step as SerializedStep).serializedStepFlow,
      },
      opts: opts ?? { concurrency: 1 },
    });
    this.steps[(step as any).id] = step as any;
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, z.ZodArray<TSchemaOut>>;
  }

  /**
   * Builds the execution graph for this workflow
   * @returns The execution graph that can be used to execute the workflow
   */
  buildExecutionGraph(): ExecutionGraph {
    return {
      id: this.id,
      steps: this.stepFlow,
    };
  }

  /**
   * Finalizes the workflow definition and prepares it for execution
   * This method should be called after all steps have been added to the workflow
   * @returns A built workflow instance ready for execution
   */
  commit() {
    this.executionGraph = this.buildExecutionGraph();
    return this as unknown as Workflow<TEngineType, TSteps, TWorkflowId, TInput, TOutput, TOutput>;
  }

  get stepGraph() {
    return this.stepFlow;
  }

  get serializedStepGraph() {
    return this.serializedStepFlow;
  }

  /**
   * Creates a new workflow run instance
   * @param options Optional configuration for the run
   * @returns A Run instance that can be used to execute the workflow
   */
  createRun(options?: { runId?: string; disableScorers?: boolean }): Run<TEngineType, TSteps, TInput, TOutput> {
    if (this.stepFlow.length === 0) {
      throw new Error(
        'Execution flow of workflow is not defined. Add steps to the workflow via .then(), .branch(), etc.',
      );
    }
    if (!this.executionGraph.steps) {
      throw new Error('Uncommitted step flow changes detected. Call .commit() to register the steps.');
    }
    const runIdToUse = options?.runId || this.#mastra?.generateId() || randomUUID();

    // Return a new Run instance with object parameters
    const run =
      this.#runs.get(runIdToUse) ??
      new Run({
        workflowId: this.id,
        runId: runIdToUse,
        executionEngine: this.executionEngine,
        executionGraph: this.executionGraph,
        mastra: this.#mastra,
        retryConfig: this.retryConfig,
        serializedStepGraph: this.serializedStepGraph,
        disableScorers: options?.disableScorers,
        cleanup: () => this.#runs.delete(runIdToUse),
      });

    this.#runs.set(runIdToUse, run);

    this.mastra?.getLogger().warn('createRun() will be removed on September 16th. Use createRunAsync() instead.');

    return run;
  }

  /**
   * Creates a new workflow run instance and stores a snapshot of the workflow in the storage
   * @param options Optional configuration for the run
   * @returns A Run instance that can be used to execute the workflow
   */
  async createRunAsync(options?: {
    runId?: string;
    disableScorers?: boolean;
  }): Promise<Run<TEngineType, TSteps, TInput, TOutput>> {
    if (this.stepFlow.length === 0) {
      throw new Error(
        'Execution flow of workflow is not defined. Add steps to the workflow via .then(), .branch(), etc.',
      );
    }
    if (!this.executionGraph.steps) {
      throw new Error('Uncommitted step flow changes detected. Call .commit() to register the steps.');
    }
    const runIdToUse = options?.runId || this.#mastra?.generateId() || randomUUID();

    // Return a new Run instance with object parameters
    const run =
      this.#runs.get(runIdToUse) ??
      new Run({
        workflowId: this.id,
        runId: runIdToUse,
        executionEngine: this.executionEngine,
        executionGraph: this.executionGraph,
        mastra: this.#mastra,
        retryConfig: this.retryConfig,
        serializedStepGraph: this.serializedStepGraph,
        disableScorers: options?.disableScorers,
        cleanup: () => this.#runs.delete(runIdToUse),
      });

    this.#runs.set(runIdToUse, run);

    const workflowSnapshotInStorage = await this.getWorkflowRunExecutionResult(runIdToUse, false);

    if (!workflowSnapshotInStorage) {
      await this.mastra?.getStorage()?.persistWorkflowSnapshot({
        workflowName: this.id,
        runId: runIdToUse,
        snapshot: {
          runId: runIdToUse,
          status: 'pending',
          value: {},
          context: {},
          activePaths: [],
          serializedStepGraph: this.serializedStepGraph,
          suspendedPaths: {},
          waitingPaths: {},
          result: undefined,
          error: undefined,
          // @ts-ignore
          timestamp: Date.now(),
        },
      });
    }

    return run;
  }

  async getScorers({
    runtimeContext = new RuntimeContext(),
  }: { runtimeContext?: RuntimeContext } = {}): Promise<MastraScorers> {
    const steps = this.steps;

    if (!steps || Object.keys(steps).length === 0) {
      return {};
    }

    const scorers: MastraScorers = {};

    for (const step of Object.values(steps)) {
      if (step.scorers) {
        let scorersToUse = step.scorers;

        if (typeof scorersToUse === 'function') {
          scorersToUse = await scorersToUse({ runtimeContext });
        }

        for (const [id, scorer] of Object.entries(scorersToUse)) {
          scorers[id] = scorer;
        }
      }
    }

    return scorers;
  }

  async execute({
    runId,
    inputData,
    resumeData,
    suspend,
    resume,
    [EMITTER_SYMBOL]: emitter,
    mastra,
    runtimeContext,
    abort,
    abortSignal,
    runCount,
    tracingContext,
  }: {
    runId?: string;
    inputData: z.infer<TInput>;
    resumeData?: any;
    getStepResult<T extends Step<any, any, any, any, any, TEngineType>>(
      stepId: T,
    ): T['outputSchema'] extends undefined ? unknown : z.infer<NonNullable<T['outputSchema']>>;
    suspend: (suspendPayload: any) => Promise<any>;
    resume?: {
      steps: string[];
      resumePayload: any;
      runId?: string;
    };
    [EMITTER_SYMBOL]: { emit: (event: string, data: any) => void };
    mastra: Mastra;
    runtimeContext?: RuntimeContext;
    engine: DefaultEngineType;
    abortSignal: AbortSignal;
    bail: (result: any) => any;
    abort: () => any;
    runCount?: number;
    tracingContext?: TracingContext;
  }): Promise<z.infer<TOutput>> {
    this.__registerMastra(mastra);

    const isResume = !!(resume?.steps && resume.steps.length > 0);
    const run = isResume ? await this.createRunAsync({ runId: resume.runId }) : await this.createRunAsync({ runId });
    const nestedAbortCb = () => {
      abort();
    };
    run.abortController.signal.addEventListener('abort', nestedAbortCb);
    abortSignal.addEventListener('abort', async () => {
      run.abortController.signal.removeEventListener('abort', nestedAbortCb);
      await run.cancel();
    });

    const unwatchV2 = run.watch(event => {
      emitter.emit('nested-watch-v2', { event, workflowId: this.id });
    }, 'watch-v2');
    const unwatch = run.watch(event => {
      emitter.emit('nested-watch', { event, workflowId: this.id, runId: run.runId, isResume: !!resume?.steps?.length });
    }, 'watch');

    if (runCount && runCount > 0 && resume?.steps?.length && runtimeContext) {
      runtimeContext.set('__mastraWorflowInputData', inputData);
    }

    const res = isResume
      ? await run.resume({ resumeData, step: resume.steps as any, runtimeContext, tracingContext })
      : await run.start({ inputData, runtimeContext, tracingContext });
    unwatch();
    unwatchV2();
    const suspendedSteps = Object.entries(res.steps).filter(([_stepName, stepResult]) => {
      const stepRes: StepResult<any, any, any, any> = stepResult as StepResult<any, any, any, any>;
      return stepRes?.status === 'suspended';
    });

    if (suspendedSteps?.length) {
      for (const [stepName, stepResult] of suspendedSteps) {
        // @ts-ignore
        const suspendPath: string[] = [stepName, ...(stepResult?.suspendPayload?.__workflow_meta?.path ?? [])];
        await suspend({
          ...(stepResult as any)?.suspendPayload,
          __workflow_meta: { runId: run.runId, path: suspendPath },
        });
      }
    }

    if (res.status === 'failed') {
      throw res.error;
    }

    return res.status === 'success' ? res.result : undefined;
  }

  async getWorkflowRuns(args?: {
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
    resourceId?: string;
  }) {
    const storage = this.#mastra?.getStorage();
    if (!storage) {
      this.logger.debug('Cannot get workflow runs. Mastra storage is not initialized');
      return { runs: [], total: 0 };
    }

    return storage.getWorkflowRuns({ workflowName: this.id, ...(args ?? {}) });
  }

  async getWorkflowRunById(runId: string) {
    const storage = this.#mastra?.getStorage();
    if (!storage) {
      this.logger.debug('Cannot get workflow runs from storage. Mastra storage is not initialized');
      //returning in memory run if no storage is initialized
      return this.#runs.get(runId)
        ? ({ ...this.#runs.get(runId), workflowName: this.id } as unknown as WorkflowRun)
        : null;
    }
    const run = await storage.getWorkflowRunById({ runId, workflowName: this.id });

    return (
      run ??
      (this.#runs.get(runId) ? ({ ...this.#runs.get(runId), workflowName: this.id } as unknown as WorkflowRun) : null)
    );
  }

  protected async getWorkflowRunSteps({ runId, workflowId }: { runId: string; workflowId: string }) {
    const storage = this.#mastra?.getStorage();
    if (!storage) {
      this.logger.debug('Cannot get workflow run steps. Mastra storage is not initialized');
      return {};
    }

    const run = await storage.getWorkflowRunById({ runId, workflowName: workflowId });

    let snapshot: WorkflowRunState | string = run?.snapshot!;

    if (!snapshot) {
      return {};
    }

    if (typeof snapshot === 'string') {
      // this occurs whenever the parsing of snapshot fails in storage
      try {
        snapshot = JSON.parse(snapshot);
      } catch (e) {
        this.logger.debug('Cannot get workflow run execution result. Snapshot is not a valid JSON string', e);
        return {};
      }
    }

    const { serializedStepGraph, context } = snapshot as WorkflowRunState;
    const { input, ...steps } = context;

    let finalSteps = {} as Record<string, StepResult<any, any, any, any>>;

    for (const step of Object.keys(steps)) {
      const stepGraph = serializedStepGraph.find(stepGraph => (stepGraph as any)?.step?.id === step);
      finalSteps[step] = steps[step] as StepResult<any, any, any, any>;
      if (stepGraph && (stepGraph as any)?.step?.component === 'WORKFLOW') {
        const nestedSteps = await this.getWorkflowRunSteps({ runId, workflowId: step });
        if (nestedSteps) {
          const updatedNestedSteps = Object.entries(nestedSteps).reduce(
            (acc, [key, value]) => {
              acc[`${step}.${key}`] = value as StepResult<any, any, any, any>;
              return acc;
            },
            {} as Record<string, StepResult<any, any, any, any>>,
          );
          finalSteps = { ...finalSteps, ...updatedNestedSteps };
        }
      }
    }

    return finalSteps;
  }

  async getWorkflowRunExecutionResult(
    runId: string,
    withNestedWorkflows: boolean = true,
  ): Promise<WatchEvent['payload']['workflowState'] | null> {
    const storage = this.#mastra?.getStorage();
    if (!storage) {
      this.logger.debug('Cannot get workflow run execution result. Mastra storage is not initialized');
      return null;
    }

    const run = await storage.getWorkflowRunById({ runId, workflowName: this.id });

    let snapshot: WorkflowRunState | string = run?.snapshot!;

    if (!snapshot) {
      return null;
    }

    if (typeof snapshot === 'string') {
      // this occurs whenever the parsing of snapshot fails in storage
      try {
        snapshot = JSON.parse(snapshot);
      } catch (e) {
        this.logger.debug('Cannot get workflow run execution result. Snapshot is not a valid JSON string', e);
        return null;
      }
    }

    const fullSteps = withNestedWorkflows
      ? await this.getWorkflowRunSteps({ runId, workflowId: this.id })
      : (snapshot as WorkflowRunState).context;

    return {
      status: (snapshot as WorkflowRunState).status,
      result: (snapshot as WorkflowRunState).result,
      error: (snapshot as WorkflowRunState).error,
      payload: (snapshot as WorkflowRunState).context?.input,
      steps: fullSteps as any,
    };
  }
}

/**
 * Represents a workflow run that can be executed
 */
export class Run<
  TEngineType = any,
  TSteps extends Step<string, any, any, any, any, TEngineType>[] = Step<string, any, any, any, any, TEngineType>[],
  TInput extends z.ZodType<any> = z.ZodType<any>,
  TOutput extends z.ZodType<any> = z.ZodType<any>,
> {
  #abortController?: AbortController;
  protected emitter: EventEmitter;
  /**
   * Unique identifier for this workflow
   */
  readonly workflowId: string;

  /**
   * Unique identifier for this run
   */
  readonly runId: string;

  /**
   * Whether to disable scorers for this run
   */
  readonly disableScorers?: boolean;

  /**
   * Internal state of the workflow run
   */
  protected state: Record<string, any> = {};

  /**
   * The execution engine for this run
   */
  public executionEngine: ExecutionEngine;

  /**
   * The execution graph for this run
   */
  public executionGraph: ExecutionGraph;

  /**
   * The serialized step graph for this run
   */
  public serializedStepGraph: SerializedStepFlowEntry[];

  /**
   * The storage for this run
   */
  #mastra?: Mastra;

  get mastra() {
    return this.#mastra;
  }

  protected closeStreamAction?: () => Promise<void>;
  protected executionResults?: Promise<WorkflowResult<TOutput, TSteps>>;

  protected cleanup?: () => void;

  protected retryConfig?: {
    attempts?: number;
    delay?: number;
  };

  /**
   * The tracing context for this run (used as fallback when user doesn't provide one)
   */
  protected tracingContext?: TracingContext;

  constructor(params: {
    workflowId: string;
    runId: string;
    executionEngine: ExecutionEngine;
    executionGraph: ExecutionGraph;
    mastra?: Mastra;
    retryConfig?: {
      attempts?: number;
      delay?: number;
    };
    cleanup?: () => void;
    serializedStepGraph: SerializedStepFlowEntry[];
    disableScorers?: boolean;
    tracingContext?: TracingContext;
  }) {
    this.workflowId = params.workflowId;
    this.runId = params.runId;
    this.serializedStepGraph = params.serializedStepGraph;
    this.executionEngine = params.executionEngine;
    this.executionGraph = params.executionGraph;
    this.#mastra = params.mastra;
    this.emitter = new EventEmitter();
    this.retryConfig = params.retryConfig;
    this.cleanup = params.cleanup;
    this.disableScorers = params.disableScorers;
    this.tracingContext = params.tracingContext;
  }

  public get abortController(): AbortController {
    if (!this.#abortController) {
      this.#abortController = new AbortController();
    }

    return this.#abortController;
  }

  /**
   * Cancels the workflow execution
   */
  async cancel() {
    this.abortController?.abort();
  }

  async sendEvent(event: string, data: any) {
    this.emitter.emit(`user-event-${event}`, data);
  }

  protected async _start({
    inputData,
    runtimeContext,
    writableStream,
    tracingContext,
    format,
  }: {
    inputData?: z.infer<TInput>;
    runtimeContext?: RuntimeContext;
    writableStream?: WritableStream<ChunkType>;
    tracingContext?: TracingContext;
    format?: 'aisdk' | 'mastra' | undefined;
  }): Promise<WorkflowResult<TOutput, TSteps>> {
    const result = await this.executionEngine.execute<z.infer<TInput>, WorkflowResult<TOutput, TSteps>>({
      workflowId: this.workflowId,
      runId: this.runId,
      disableScorers: this.disableScorers,
      graph: this.executionGraph,
      serializedStepGraph: this.serializedStepGraph,
      input: inputData,
      emitter: {
        emit: async (event: string, data: any) => {
          this.emitter.emit(event, data);
        },
        on: (event: string, callback: (data: any) => void) => {
          this.emitter.on(event, callback);
        },
        off: (event: string, callback: (data: any) => void) => {
          this.emitter.off(event, callback);
        },
        once: (event: string, callback: (data: any) => void) => {
          this.emitter.once(event, callback);
        },
      },
      retryConfig: this.retryConfig,
      runtimeContext: runtimeContext ?? new RuntimeContext(),
      abortController: this.abortController,
      writableStream,
      tracingContext,
      format,
    });

    if (result.status !== 'suspended') {
      this.cleanup?.();
    }

    return result;
  }

  /**
   * Starts the workflow execution with the provided input
   * @param input The input data for the workflow
   * @returns A promise that resolves to the workflow output
   */
  async start({
    inputData,
    runtimeContext,
    writableStream,
    tracingContext,
  }: {
    inputData?: z.infer<TInput>;
    runtimeContext?: RuntimeContext;
    writableStream?: WritableStream<ChunkType>;
    tracingContext?: TracingContext;
  }): Promise<WorkflowResult<TOutput, TSteps>> {
    // Use provided tracingContext or fall back to stored tracingContext
    const effectiveTracingContext = tracingContext ?? this.tracingContext;
    return this._start({
      inputData,
      runtimeContext,
      writableStream,
      tracingContext: effectiveTracingContext,
      format: 'aisdk',
    });
  }

  /**
   * Starts the workflow execution with the provided input as a stream
   * @param input The input data for the workflow
   * @returns A promise that resolves to the workflow output
   */
  stream({
    inputData,
    runtimeContext,
    tracingContext,
  }: {
    inputData?: z.infer<TInput>;
    runtimeContext?: RuntimeContext;
    tracingContext?: TracingContext;
  } = {}): {
    stream: ReadableStream<StreamEvent>;
    getWorkflowState: () => Promise<WorkflowResult<TOutput, TSteps>>;
  } {
    const { readable, writable } = new TransformStream<StreamEvent, StreamEvent>();

    let currentToolData: { name: string; args: any } | undefined = undefined;

    const writer = writable.getWriter();
    const unwatch = this.watch(async event => {
      if ((event as any).type === 'workflow-agent-call-start') {
        currentToolData = {
          name: (event as any).payload.name,
          args: (event as any).payload.args,
        };
        await writer.write({
          ...event.payload,
          type: 'tool-call-streaming-start',
        } as any);

        return;
      }

      try {
        if ((event as any).type === 'workflow-agent-call-finish') {
          return;
        } else if (!(event as any).type.startsWith('workflow-')) {
          if ((event as any).type === 'text-delta') {
            await writer.write({
              type: 'tool-call-delta',
              ...(currentToolData ?? {}),
              argsTextDelta: (event as any).textDelta,
            } as any);
          }
          return;
        }

        const e: any = {
          ...event,
          type: event.type.replace('workflow-', ''),
        };
        // watch-v2 events are data stream events, so we need to cast them to the correct type
        await writer.write(e as any);
      } catch {}
    }, 'watch-v2');

    this.closeStreamAction = async () => {
      this.emitter.emit('watch-v2', {
        type: 'workflow-finish',
        payload: { runId: this.runId },
      });
      unwatch();

      try {
        await writer.close();
      } catch (err) {
        console.error('Error closing stream:', err);
      } finally {
        writer.releaseLock();
      }
    };

    this.emitter.emit('watch-v2', {
      type: 'workflow-start',
      payload: { runId: this.runId },
    });
    this.executionResults = this._start({
      inputData,
      runtimeContext,
      format: 'aisdk',
      tracingContext,
    }).then(result => {
      if (result.status !== 'suspended') {
        this.closeStreamAction?.().catch(() => {});
      }

      return result;
    });

    return {
      stream: readable,
      getWorkflowState: () => this.executionResults!,
    };
  }

  async streamAsync({
    inputData,
    runtimeContext,
  }: { inputData?: z.infer<TInput>; runtimeContext?: RuntimeContext } = {}): Promise<{
    stream: ReadableStream<StreamEvent>;
    getWorkflowState: () => Promise<WorkflowResult<TOutput, TSteps>>;
  }> {
    return this.stream({ inputData, runtimeContext });
  }

  /**
   * Starts the workflow execution with the provided input as a stream
   * @param input The input data for the workflow
   * @returns A promise that resolves to the workflow output
   */
  streamVNext({
    inputData,
    runtimeContext,
    format,
  }: { inputData?: z.infer<TInput>; runtimeContext?: RuntimeContext; format?: 'aisdk' | 'mastra' | undefined } = {}) {
    this.closeStreamAction = async () => {};

    return new MastraWorkflowStream({
      run: this,
      createStream: writer => {
        const { readable, writable } = new TransformStream<ChunkType, ChunkType>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });

        let buffer: ChunkType[] = [];
        let isWriting = false;
        const tryWrite = async () => {
          const chunkToWrite = buffer;
          buffer = [];

          if (chunkToWrite.length === 0 || isWriting) {
            return;
          }
          isWriting = true;

          let watchWriter = writer.getWriter();
          try {
            for (const chunk of chunkToWrite) {
              await watchWriter.write(chunk);
            }
          } finally {
            watchWriter.releaseLock();
          }
          isWriting = false;

          setImmediate(tryWrite);
        };

        // TODO: fix this, watch-v2 doesn't have a type
        // @ts-ignore
        const unwatch = this.watch(async ({ type, from = ChunkFrom.WORKFLOW, payload }) => {
          buffer.push({
            type,
            runId: this.runId,
            from,
            payload: {
              stepName: (payload as unknown as { id: string }).id,
              ...payload,
            },
          });

          await tryWrite();
        }, 'watch-v2');

        this.closeStreamAction = async () => {
          unwatch();

          try {
            await writable.close();
          } catch (err) {
            console.error('Error closing stream:', err);
          }
        };

        const executionResults = this._start({ inputData, runtimeContext, writableStream: writable, format }).then(
          result => {
            if (result.status !== 'suspended') {
              this.closeStreamAction?.().catch(() => {});
            }

            return result;
          },
        );
        this.executionResults = executionResults;

        return readable;
      },
    });
  }

  watch(cb: (event: WatchEvent) => void, type: 'watch' | 'watch-v2' = 'watch'): () => void {
    const watchCb = (event: WatchEvent) => {
      this.updateState(event.payload);
      cb({ type: event.type, payload: this.getState() as any, eventTimestamp: event.eventTimestamp });
    };

    const nestedWatchCb = ({ event, workflowId }: { event: WatchEvent; workflowId: string }) => {
      try {
        const { type, payload, eventTimestamp } = event;
        const prefixedSteps = Object.fromEntries(
          Object.entries(payload?.workflowState?.steps ?? {}).map(([stepId, step]) => [
            `${workflowId}.${stepId}`,
            step,
          ]),
        );
        const newPayload: any = {
          currentStep: {
            ...payload?.currentStep,
            id: `${workflowId}.${payload?.currentStep?.id}`,
          },
          workflowState: {
            steps: prefixedSteps,
          },
        };
        this.updateState(newPayload);
        cb({ type, payload: this.getState() as any, eventTimestamp: eventTimestamp });
      } catch (e) {
        console.error(e);
      }
    };

    const nestedWatchV2Cb = ({
      event,
      workflowId,
    }: {
      event: { type: string; payload: { id: string } & Record<string, unknown> };
      workflowId: string;
    }) => {
      this.emitter.emit('watch-v2', {
        ...event,
        ...(event.payload?.id ? { payload: { ...event.payload, id: `${workflowId}.${event.payload.id}` } } : {}),
      });
    };

    if (type === 'watch') {
      this.emitter.on('watch', watchCb);
      this.emitter.on('nested-watch', nestedWatchCb);
    } else if (type === 'watch-v2') {
      this.emitter.on('watch-v2', cb);
      this.emitter.on('nested-watch-v2', nestedWatchV2Cb);
    }

    return () => {
      if (type === 'watch-v2') {
        this.emitter.off('watch-v2', cb);
        this.emitter.off('nested-watch-v2', nestedWatchV2Cb);
      } else {
        this.emitter.off('watch', watchCb);
        this.emitter.off('nested-watch', nestedWatchCb);
      }
    };
  }

  async watchAsync(cb: (event: WatchEvent) => void, type: 'watch' | 'watch-v2' = 'watch'): Promise<() => void> {
    return this.watch(cb, type);
  }

  async resume<TResumeSchema extends z.ZodType<any>>(params: {
    resumeData?: z.infer<TResumeSchema>;
    step?:
      | Step<string, any, any, TResumeSchema, any, TEngineType>
      | [...Step<string, any, any, any, any, TEngineType>[], Step<string, any, any, TResumeSchema, any, TEngineType>]
      | string
      | string[];
    runtimeContext?: RuntimeContext;
    runCount?: number;
    tracingContext?: TracingContext;
  }): Promise<WorkflowResult<TOutput, TSteps>> {
    const snapshot = await this.#mastra?.getStorage()?.loadWorkflowSnapshot({
      workflowName: this.workflowId,
      runId: this.runId,
    });

    if (!snapshot) {
      throw new Error('No snapshot found for this workflow run');
    }

    // Auto-detect suspended steps if no step is provided
    let steps: string[];
    if (params.step) {
      steps = (Array.isArray(params.step) ? params.step : [params.step]).map(step =>
        typeof step === 'string' ? step : step?.id,
      );
    } else {
      // Use suspendedPaths to detect suspended steps
      const suspendedStepPaths: string[][] = [];

      Object.entries(snapshot?.suspendedPaths ?? {}).forEach(([stepId, _executionPath]) => {
        // Check if this step has nested workflow suspension data
        const stepResult = snapshot?.context?.[stepId];
        if (stepResult && typeof stepResult === 'object' && 'status' in stepResult) {
          const stepRes = stepResult as any;
          if (stepRes.status === 'suspended') {
            const nestedPath = stepRes.suspendPayload?.__workflow_meta?.path;
            if (nestedPath && Array.isArray(nestedPath)) {
              // For nested workflows, combine the parent step ID with the nested path
              suspendedStepPaths.push([stepId, ...nestedPath]);
            } else {
              // For single-level suspension, just use the step ID
              suspendedStepPaths.push([stepId]);
            }
          }
        }
      });

      if (suspendedStepPaths.length === 0) {
        throw new Error('No suspended steps found in this workflow run');
      }

      if (suspendedStepPaths.length === 1) {
        // For single suspended step, use the full path
        steps = suspendedStepPaths[0]!;
      } else {
        const pathStrings = suspendedStepPaths.map(path => `[${path.join(', ')}]`);
        throw new Error(
          `Multiple suspended steps found: ${pathStrings.join(', ')}. ` +
            'Please specify which step to resume using the "step" parameter.',
        );
      }
    }

    if (!params.runCount) {
      if (snapshot.status !== 'suspended') {
        throw new Error('This workflow run was not suspended');
      }

      const suspendedStepIds = Object.keys(snapshot?.suspendedPaths ?? {});

      const isStepSuspended = suspendedStepIds.includes(steps?.[0] ?? '');

      if (!isStepSuspended) {
        throw new Error(
          `This workflow step "${steps?.[0]}" was not suspended. Available suspended steps: [${suspendedStepIds.join(', ')}]`,
        );
      }
    }

    let runtimeContextInput;
    if (params.runCount && params.runCount > 0 && params.runtimeContext) {
      runtimeContextInput = params.runtimeContext.get('__mastraWorflowInputData');
      params.runtimeContext.delete('__mastraWorflowInputData');
    }

    const stepResults = { ...(snapshot?.context ?? {}), input: runtimeContextInput ?? snapshot?.context?.input } as any;

    let runtimeContextToUse = params.runtimeContext ?? new RuntimeContext();

    Object.entries(snapshot?.runtimeContext ?? {}).forEach(([key, value]) => {
      if (!runtimeContextToUse.has(key)) {
        runtimeContextToUse.set(key, value);
      }
    });

    const executionResultPromise = this.executionEngine
      .execute<z.infer<TInput>, WorkflowResult<TOutput, TSteps>>({
        workflowId: this.workflowId,
        runId: this.runId,
        graph: this.executionGraph,
        serializedStepGraph: this.serializedStepGraph,
        input: snapshot?.context?.input,
        resume: {
          steps,
          stepResults,
          resumePayload: params.resumeData,
          // @ts-ignore
          resumePath: snapshot?.suspendedPaths?.[steps?.[0]] as any,
        },
        emitter: {
          emit: (event: string, data: any) => {
            this.emitter.emit(event, data);
            return Promise.resolve();
          },
          on: (event: string, callback: (data: any) => void) => {
            this.emitter.on(event, callback);
          },
          off: (event: string, callback: (data: any) => void) => {
            this.emitter.off(event, callback);
          },
          once: (event: string, callback: (data: any) => void) => {
            this.emitter.once(event, callback);
          },
        },
        runtimeContext: runtimeContextToUse,
        abortController: this.abortController,
        tracingContext: params.tracingContext,
      })
      .then(result => {
        if (result.status !== 'suspended') {
          this.closeStreamAction?.().catch(() => {});
        }

        return result;
      });

    this.executionResults = executionResultPromise;

    return executionResultPromise;
  }

  /**
   * Returns the current state of the workflow run
   * @returns The current state of the workflow run
   */
  getState(): Record<string, any> {
    return this.state;
  }

  updateState(state: Record<string, any>) {
    if (state.currentStep) {
      this.state.currentStep = state.currentStep;
    } else if (state.workflowState?.status !== 'running') {
      delete this.state.currentStep;
    }

    if (state.workflowState) {
      this.state.workflowState = deepMergeWorkflowState(this.state.workflowState ?? {}, state.workflowState ?? {});
    }
  }

  /**
   * @access private
   * @returns The execution results of the workflow run
   */
  _getExecutionResults() {
    return this.executionResults;
  }
}

function deepMergeWorkflowState(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  if (!a || typeof a !== 'object') return b;
  if (!b || typeof b !== 'object') return a;

  const result = { ...a };

  for (const key in b) {
    if (b[key] === undefined) continue;

    if (b[key] !== null && typeof b[key] === 'object') {
      const aVal = result[key];
      const bVal = b[key];

      if (Array.isArray(bVal)) {
        //we should just replace it instead of spreading as we do for others
        //spreading aVal and then bVal will result in duplication of items
        result[key] = bVal.filter(item => item !== undefined);
      } else if (typeof aVal === 'object' && aVal !== null) {
        // If both values are objects, merge them
        result[key] = deepMergeWorkflowState(aVal, bVal);
      } else {
        // If the target isn't an object, use the source object
        result[key] = bVal;
      }
    } else {
      result[key] = b[key];
    }
  }

  return result;
}
