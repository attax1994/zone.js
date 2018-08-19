import {
  ZoneType,
  _PatchFn,
  _ZonePrivate,
  _ZoneFrame,
  UncaughtPromiseError,
  ZoneSpec,
  ZoneDelegate,
  HasTaskState,
  TaskType,
  TaskState,
  TaskData,
  Task,
  MicroTask,
  MacroTask,
  EventTask,
  AmbientZone,
  AmbientZoneDelegate
} from './zone.interface'

/**
 * Zone.js的全局创建（Central Controller）
 * global通常就是window，除非NodeJS下使用global
 */
const Zone: ZoneType = (function (global: any) {

  /**
   * Performance API，追踪Zone构建的速度
   */
  const performance: { mark(name: string): void; measure(name: string, label: string): void; } = global['performance']
  const mark = (name: string) => performance && performance['mark'] && performance['mark'](name)
  const performanceMeasure = (name: string, label: string) => performance && performance['measure'] && performance['measure'](name, label)

  // 记录Zone的创建
  mark('Zone')
  // 防止重复创建（Zone模块是放在全局之下的单例）
  if (global['Zone']) throw new Error('Zone already loaded.')

  /**
   * Zone类
   */
  class Zone implements AmbientZone {
    static __symbol__: (name: string) => string = __symbol__;

    // 必须在zone.js前导入Promise的polyfill
    static assertZonePatched() {
      if (global['Promise'] !== patches['ZoneAwarePromise']) {
        throw new Error('请在Zone.js执行前导入Promise的polyfill，否则Zone不会对其进行Monkey Patch（所有Patch过的方法，都放在patches对象下了）！！！')
      }
    }

    /**
     * 获取根Zone（Zone是树形结构，子节点通过parent属性来记录父节点，所以只需要一层一层向上寻找）
     */
    static get root(): AmbientZone {
      let zone = Zone.current;
      while (zone.parent) {
        zone = zone.parent;
      }
      return zone;
    }

    /**
     * 执行某个Patch，存入patches字典中
     * 这里就是执行MonkeyPatch
     */
    static __load_patch(name: string, fn: _PatchFn): void {
      if (patches.hasOwnProperty(name)) {
        throw Error('Already loaded patch: ' + name);
      } else if (!global['__Zone_disable_' + name]) {
        const perfName = 'Zone:' + name;
        mark(perfName);
        patches[name] = fn(global, Zone, _api);
        performanceMeasure(perfName, perfName);
      }
    }

    /**
     * 获取当前正在处理的Zone
     */
    static get current(): AmbientZone {
      return _currentZoneFrame.zone;
    }

    static get currentTask(): Task | null {
      return _currentTask;
    }

    public get parent(): AmbientZone | null {
      return this._parent;
    }

    public get name(): string {
      return this._name;
    }

    // 父Zone
    private readonly _parent: Zone | null;
    // 名称
    private readonly _name: string;
    // 属性（字典的形式）
    private _properties: { [key: string]: any };
    /**
     * 每个Zone都会有一个ZoneDelegate对象，
     * 主要为Zone调用传入的回调函数，建立、调用回调函数中的异步任务，捕捉异步任务的错误
     */
    private _zoneDelegate: ZoneDelegate;

    constructor(parent: Zone | null, zoneSpec: ZoneSpec | null) {
      this._parent = parent;
      this._name = zoneSpec ? zoneSpec.name || 'unnamed' : '<root>';
      this._properties = zoneSpec && zoneSpec.properties || {};
      this._zoneDelegate = new ZoneDelegate(this, this._parent && this._parent._zoneDelegate, zoneSpec);
    }

    /**
     * 得到某个key的值（在Zone树上从下往上找）
     * 这个方法在进行依赖注入，寻找对应Provider的时候非常重要！！！
     */
    public get(key: string): any {
      const zone: Zone = this.getZoneWith(key) as Zone;
      if (zone) return zone._properties[key];
    }

    /**
     * 从自身出发，一层层向上找属性中有传入的key的Zone
     * 可以用来定位具有某个Provider的Zone
     */
    public getZoneWith(key: string): AmbientZone | null {
      let current: Zone | null = this;
      while (current) {
        if (current._properties.hasOwnProperty(key)) {
          return current;
        }
        current = current._parent;
      }
      return null;
    }

    /**
     * 生成一个子Zone，是对new Zone(parent, zoneSpec)的封装
     * Zone推荐用fork去代替构造函数，这样不会将parent传错
     */
    public fork(zoneSpec: ZoneSpec): AmbientZone {
      if (!zoneSpec) throw new Error('ZoneSpec必须传入！！!');
      return this._zoneDelegate.fork(this, zoneSpec);
    }

    /**
     * 对函数的调用进行封装
     */
    public wrap<T extends Function>(callback: T, source: string): T {
      if (typeof callback !== 'function') {
        throw new Error('Expecting function got: ' + callback);
      }
      const _callback = this._zoneDelegate.intercept(this, callback, source);
      const zone: Zone = this;
      return function () {
        return zone.runGuarded(_callback, (this as any), <any>arguments, source);
      } as any as T;
    }

    /**
     * 执行某个函数
     * 1.将currentZoneFrame切换到子Zone，记录原先父Zone的为parent
     * 2.触发delegate的onInvoke方法（如果有）
     */
    public run(callback: Function, applyThis?: any, applyArgs?: any[], source?: string): any;
    public run<T>(
      callback: (...args: any[]) => T,
      applyThis?: any,
      applyArgs?: any[],
      source?: string
    ): T {
      _currentZoneFrame = {parent: _currentZoneFrame, zone: this};
      try {
        return this._zoneDelegate.invoke(this, callback, applyThis, applyArgs, source);
      } finally {
        _currentZoneFrame = _currentZoneFrame.parent!;
      }
    }

    // 带有error处理的run
    public runGuarded(callback: Function, applyThis?: any, applyArgs?: any[], source?: string): any;
    public runGuarded<T>(callback: (...args: any[]) => T, applyThis: any = null, applyArgs?: any[], source?: string) {
      _currentZoneFrame = {parent: _currentZoneFrame, zone: this};
      try {
        return this._zoneDelegate.invoke(this, callback, applyThis, applyArgs, source);
      } catch (error) {
        if (this._zoneDelegate.handleError(this, error)) {
          throw error;
        }
      } finally {
        _currentZoneFrame = _currentZoneFrame.parent!;
      }
    }

    /**
     * 执行任务
     * 1. task只能在创建它的Zone中运行，不能跨Zone
     * 2. 不执行notScheduled的eventTask（触发后才scheduled）
     */
    runTask(task: Task, applyThis?: any, applyArgs?: any): any {
      if (task.zone != this) {
        throw new Error(
          'A task can only be run in the zone of creation! (Creation: ' +
          (task.zone || NO_ZONE).name + '; Execution: ' + this.name + ')');
      }

      // 不执行未schedule的eventTask
      if (task.state === notScheduled && task.type === eventTask) {
        return;
      }

      // 放个running标志位，避免重复执行
      const reEntryGuard = task.state != running;
      reEntryGuard && (task as ZoneTask<any>)._transitionTo(running, scheduled);

      task.runCount++;
      // 切换当前任务和ZoneFrame
      const previousTask = _currentTask;
      _currentTask = task;
      _currentZoneFrame = {parent: _currentZoneFrame, zone: this};
      // 执行任务
      try {
        if (task.type == macroTask && task.data && !task.data.isPeriodic) {
          task.cancelFn = undefined;
        }
        try {
          return this._zoneDelegate.invokeTask(this, task, applyThis, applyArgs);
        } catch (error) {
          if (this._zoneDelegate.handleError(this, error)) {
            throw error;
          }
        }
      } finally {
        // 对于已经取消的事件，state应该为notScheduled或者unknown，不应该将其重置为scheduled
        if (task.state !== notScheduled && task.state !== unknown) {
          if (task.type == eventTask || (task.data && task.data.isPeriodic)) {
            // 已经完成，切到scheduled
            reEntryGuard && (task as ZoneTask<any>)._transitionTo(scheduled, running);
          } else {
            // 未完成，切回notScheduled
            task.runCount = 0;
            this._updateTaskCount(task as ZoneTask<any>, -1);
            reEntryGuard &&
            (task as ZoneTask<any>)._transitionTo(notScheduled, running, notScheduled);
          }
        }
        // 回归原来的任务和ZoneFrame
        _currentZoneFrame = _currentZoneFrame.parent!;
        _currentTask = previousTask;
      }
    }

    /**
     * 安排任务执行
     */
    scheduleTask<T extends Task>(task: T): T {
      if (task.zone && task.zone !== this) {
        // 不能在子Zone中执行父Zone的任务（否则无法更新父Zone）
        let newZone: any = this;
        while (newZone) {
          if (newZone === task.zone) {
            throw Error(`can not reschedule task to ${
              this.name} which is descendants of the original zone ${task.zone.name}`);
          }
          newZone = newZone.parent;
        }
      }
      // 状态切为scheduling
      (task as any as ZoneTask<any>)._transitionTo(scheduling, notScheduled);
      const zoneDelegates: ZoneDelegate[] = [];
      (task as any as ZoneTask<any>)._zoneDelegates = zoneDelegates;
      (task as any as ZoneTask<any>)._zone = this;
      // 安排执行
      try {
        task = this._zoneDelegate.scheduleTask(this, task) as T;
      } catch (err) {
        // 有错误情况下，切回unknown
        (task as any as ZoneTask<any>)._transitionTo(unknown, scheduling, notScheduled);
        this._zoneDelegate.handleError(this, err);
        throw err;
      }
      if ((task as any as ZoneTask<any>)._zoneDelegates === zoneDelegates) {
        this._updateTaskCount(task as any as ZoneTask<any>, 1);
      }
      // 安排完成后，切换到scheduled
      if ((task as any as ZoneTask<any>).state == scheduling) {
        (task as any as ZoneTask<any>)._transitionTo(scheduled, scheduling);
      }
      return task;
    }

    scheduleMicroTask(source: string, callback: Function, data?: TaskData, customSchedule?: (task: Task) => void): MicroTask {
      return this.scheduleTask(new ZoneTask(microTask, source, callback, data, customSchedule, undefined));
    }

    scheduleMacroTask(source: string, callback: Function, data?: TaskData, customSchedule?: (task: Task) => void, customCancel?: (task: Task) => void): MacroTask {
      return this.scheduleTask(new ZoneTask(macroTask, source, callback, data, customSchedule, customCancel));
    }

    scheduleEventTask(source: string, callback: Function, data?: TaskData, customSchedule?: (task: Task) => void, customCancel?: (task: Task) => void): EventTask {
      return this.scheduleTask(new ZoneTask(eventTask, source, callback, data, customSchedule, customCancel));
    }

    /**
     * 取消任务
     */
    cancelTask(task: Task): any {
      if (task.zone != this)
        throw new Error('A task can only be cancelled in the zone of creation! (Creation: ' +
          (task.zone || NO_ZONE).name + '; Execution: ' + this.name + ')');

      (task as ZoneTask<any>)._transitionTo(canceling, scheduled, running);
      try {
        this._zoneDelegate.cancelTask(this, task);
      } catch (err) {
        (task as ZoneTask<any>)._transitionTo(unknown, canceling);
        this._zoneDelegate.handleError(this, err);
        throw err;
      }
      this._updateTaskCount(task as ZoneTask<any>, -1);
      (task as ZoneTask<any>)._transitionTo(notScheduled, canceling);
      task.runCount = 0;
      return task;
    }

    private _updateTaskCount(task: ZoneTask<any>, count: number) {
      const zoneDelegates = task._zoneDelegates!;
      if (count == -1) {
        task._zoneDelegates = null;
      }
      for (let i = 0; i < zoneDelegates.length; i++) {
        zoneDelegates[i]._updateTaskCount(task.type, count);
      }
    }
  }

  /**
   * ZoneDelegate的默认事件处理方法
   */
  const DELEGATE_ZS: ZoneSpec = {
    name: '',
    onHasTask:
      (delegate: AmbientZoneDelegate, _: AmbientZone, target: AmbientZone, hasTaskState: HasTaskState): void =>
        delegate.hasTask(target, hasTaskState),
    onScheduleTask:
      (delegate: AmbientZoneDelegate, _: AmbientZone, target: AmbientZone, task: Task): Task =>
        delegate.scheduleTask(target, task),
    onInvokeTask:
      (delegate: AmbientZoneDelegate, _: AmbientZone, target: AmbientZone, task: Task, applyThis: any, applyArgs: any): any =>
        delegate.invokeTask(target, task, applyThis, applyArgs),
    onCancelTask:
      (delegate: AmbientZoneDelegate, _: AmbientZone, target: AmbientZone, task: Task): any =>
        delegate.cancelTask(target, task)
  };

  /**
   * ZoneDelegate，任务下发器
   * 注意几个名词：
   * Dlgt: Delegate
   * ZS: ZoneSpec
   */
  class ZoneDelegate implements AmbientZoneDelegate {
    public zone: Zone;

    private _taskCounts: {
      microTask: number,
      macroTask: number,
      eventTask: number
    } = {'microTask': 0, 'macroTask': 0, 'eventTask': 0};

    private _parentDelegate: ZoneDelegate | null;

    private _forkDlgt: ZoneDelegate | null;
    private _forkZS: ZoneSpec | null;
    private _forkCurrZone: Zone | null;

    private _interceptDlgt: ZoneDelegate | null;
    private _interceptZS: ZoneSpec | null;
    private _interceptCurrZone: Zone | null;

    private _invokeDlgt: ZoneDelegate | null;
    private _invokeZS: ZoneSpec | null;
    private _invokeCurrZone: Zone | null;

    private _handleErrorDlgt: ZoneDelegate | null;
    private _handleErrorZS: ZoneSpec | null;
    private _handleErrorCurrZone: Zone | null;

    private _scheduleTaskDlgt: ZoneDelegate | null;
    private _scheduleTaskZS: ZoneSpec | null;
    private _scheduleTaskCurrZone: Zone | null;

    private _invokeTaskDlgt: ZoneDelegate | null;
    private _invokeTaskZS: ZoneSpec | null;
    private _invokeTaskCurrZone: Zone | null;

    private _cancelTaskDlgt: ZoneDelegate | null;
    private _cancelTaskZS: ZoneSpec | null;
    private _cancelTaskCurrZone: Zone | null;

    private _hasTaskDlgt: ZoneDelegate | null;
    private _hasTaskDlgtOwner: ZoneDelegate | null;
    private _hasTaskZS: ZoneSpec | null;
    private _hasTaskCurrZone: Zone | null;

    constructor(zone: Zone, parentDelegate: ZoneDelegate | null, zoneSpec: ZoneSpec | null) {
      this.zone = zone;
      this._parentDelegate = parentDelegate;

      this._forkZS = zoneSpec && (zoneSpec && zoneSpec.onFork ? zoneSpec : parentDelegate!._forkZS);
      this._forkDlgt = zoneSpec && (zoneSpec.onFork ? parentDelegate : parentDelegate!._forkDlgt);
      this._forkCurrZone = zoneSpec && (zoneSpec.onFork ? this.zone : parentDelegate!.zone);

      this._interceptZS = zoneSpec && (zoneSpec.onIntercept ? zoneSpec : parentDelegate!._interceptZS);
      this._interceptDlgt = zoneSpec && (zoneSpec.onIntercept ? parentDelegate : parentDelegate!._interceptDlgt);
      this._interceptCurrZone = zoneSpec && (zoneSpec.onIntercept ? this.zone : parentDelegate!.zone);

      this._invokeZS = zoneSpec && (zoneSpec.onInvoke ? zoneSpec : parentDelegate!._invokeZS);
      this._invokeDlgt = zoneSpec && (zoneSpec.onInvoke ? parentDelegate! : parentDelegate!._invokeDlgt);
      this._invokeCurrZone = zoneSpec && (zoneSpec.onInvoke ? this.zone : parentDelegate!.zone);

      this._handleErrorZS = zoneSpec && (zoneSpec.onHandleError ? zoneSpec : parentDelegate!._handleErrorZS);
      this._handleErrorDlgt = zoneSpec && (zoneSpec.onHandleError ? parentDelegate! : parentDelegate!._handleErrorDlgt);
      this._handleErrorCurrZone = zoneSpec && (zoneSpec.onHandleError ? this.zone : parentDelegate!.zone);

      this._scheduleTaskZS = zoneSpec && (zoneSpec.onScheduleTask ? zoneSpec : parentDelegate!._scheduleTaskZS);
      this._scheduleTaskDlgt = zoneSpec && (zoneSpec.onScheduleTask ? parentDelegate! : parentDelegate!._scheduleTaskDlgt);
      this._scheduleTaskCurrZone = zoneSpec && (zoneSpec.onScheduleTask ? this.zone : parentDelegate!.zone);

      this._invokeTaskZS = zoneSpec && (zoneSpec.onInvokeTask ? zoneSpec : parentDelegate!._invokeTaskZS);
      this._invokeTaskDlgt = zoneSpec && (zoneSpec.onInvokeTask ? parentDelegate! : parentDelegate!._invokeTaskDlgt);
      this._invokeTaskCurrZone = zoneSpec && (zoneSpec.onInvokeTask ? this.zone : parentDelegate!.zone);

      this._cancelTaskZS = zoneSpec && (zoneSpec.onCancelTask ? zoneSpec : parentDelegate!._cancelTaskZS);
      this._cancelTaskDlgt = zoneSpec && (zoneSpec.onCancelTask ? parentDelegate! : parentDelegate!._cancelTaskDlgt);
      this._cancelTaskCurrZone = zoneSpec && (zoneSpec.onCancelTask ? this.zone : parentDelegate!.zone);

      this._hasTaskZS = null;
      this._hasTaskDlgt = null;
      this._hasTaskDlgtOwner = null;
      this._hasTaskCurrZone = null;

      const zoneSpecHasTask = zoneSpec && zoneSpec.onHasTask;
      const parentHasTask = parentDelegate && parentDelegate._hasTaskZS;
      if (zoneSpecHasTask || parentHasTask) {
        // If we need to report hasTask, than this ZS needs to do ref counting on tasks. In such
        // a case all task related interceptors must go through this ZD. We can't short circuit it.
        this._hasTaskZS = zoneSpecHasTask ? zoneSpec : DELEGATE_ZS;
        this._hasTaskDlgt = parentDelegate;
        this._hasTaskDlgtOwner = this;
        this._hasTaskCurrZone = zone;
        if (!zoneSpec!.onScheduleTask) {
          this._scheduleTaskZS = DELEGATE_ZS;
          this._scheduleTaskDlgt = parentDelegate!;
          this._scheduleTaskCurrZone = this.zone;
        }
        if (!zoneSpec!.onInvokeTask) {
          this._invokeTaskZS = DELEGATE_ZS;
          this._invokeTaskDlgt = parentDelegate!;
          this._invokeTaskCurrZone = this.zone;
        }
        if (!zoneSpec!.onCancelTask) {
          this._cancelTaskZS = DELEGATE_ZS;
          this._cancelTaskDlgt = parentDelegate!;
          this._cancelTaskCurrZone = this.zone;
        }
      }
    }

    /**
     * 触发onFork事件，生成子Zone
     */
    fork(targetZone: Zone, zoneSpec: ZoneSpec): AmbientZone {
      return this._forkZS
        ? this._forkZS.onFork!(this._forkDlgt!, this.zone, targetZone, zoneSpec)
        : new Zone(targetZone, zoneSpec);
    }

    /**
     * 拦截某个函数的调用，触发onIntercept来获得回调函数
     */
    intercept(targetZone: Zone, callback: Function, source: string): Function {
      return this._interceptZS
        ? this._interceptZS.onIntercept!(this._interceptDlgt!, this._interceptCurrZone!, targetZone, callback, source)
        : callback;
    }

    /**
     * 执行方法
     */
    invoke(targetZone: Zone, callback: Function, applyThis: any, applyArgs?: any[], source?: string): any {
      return this._invokeZS
        ? this._invokeZS.onInvoke!(
          this._invokeDlgt!,
          this._invokeCurrZone!,
          targetZone,
          callback,
          applyThis,
          applyArgs,
          source)
        : callback.apply(applyThis, applyArgs);
    }

    handleError(targetZone: Zone, error: any): boolean {
      return this._handleErrorZS
        ? this._handleErrorZS.onHandleError!(this._handleErrorDlgt!, this._handleErrorCurrZone!, targetZone, error)
        : true;
    }

    /**
     * 安排任务执行，对于scheduleFn的选择，遵循以下顺序：
     * 1. delegate 实例指定的 this._scheduleTaskZS.onScheduleTask
     * 2. task.scheduleFn
     * 3. 对于microTask，采用scheduleMicroTask
     */
    scheduleTask(targetZone: Zone, task: Task): Task {
      let returnTask: ZoneTask<any> = task as ZoneTask<any>;
      if (this._scheduleTaskZS) {
        if (this._hasTaskZS) {
          returnTask._zoneDelegates!.push(this._hasTaskDlgtOwner!);
        }
        returnTask = this._scheduleTaskZS.onScheduleTask!
        (this._scheduleTaskDlgt!, this._scheduleTaskCurrZone!, targetZone, task) as ZoneTask<any>;
        if (!returnTask) returnTask = task as ZoneTask<any>;
      } else {
        if (task.scheduleFn) {
          task.scheduleFn(task);
        } else if (task.type == microTask) {
          scheduleMicroTask(<MicroTask>task);
        } else {
          throw new Error('Task is missing scheduleFn.');
        }
      }
      return returnTask;
    }

    /**
     * 执行任务，触发onInvokeTask事件
     */
    invokeTask(targetZone: Zone, task: Task, applyThis: any, applyArgs?: any[]): any {
      return this._invokeTaskZS
        ? this._invokeTaskZS.onInvokeTask!(this._invokeTaskDlgt!, this._invokeTaskCurrZone!, targetZone, task, applyThis, applyArgs)
        : task.callback.apply(applyThis, applyArgs);
    }

    /**
     * 取消任务，触发onCancelTask事件
     */
    cancelTask(targetZone: Zone, task: Task): any {
      let value: any;
      if (this._cancelTaskZS) {
        value = this._cancelTaskZS.onCancelTask!
        (this._cancelTaskDlgt!, this._cancelTaskCurrZone!, targetZone, task);
      } else {
        if (!task.cancelFn) {
          throw Error('Task is not cancelable');
        }
        value = task.cancelFn(task);
      }
      return value;
    }

    /**
     * 检查某个Zone中是否还有某类任务，触发onHasTask事件
     */
    hasTask(targetZone: Zone, isEmpty: HasTaskState) {
      try {
        this._hasTaskZS &&
        this._hasTaskZS.onHasTask!(this._hasTaskDlgt!, this._hasTaskCurrZone!, targetZone, isEmpty);
      } catch (err) {
        this.handleError(targetZone, err);
      }
    }

    /**
     * 更新taskCount
     */
    _updateTaskCount(type: TaskType, count: number) {
      const counts = this._taskCounts;
      const prev = counts[type];
      const next = counts[type] = prev + count;
      if (next < 0) {
        throw new Error('More tasks executed then were scheduled.');
      }
      if (prev == 0 || next == 0) {
        const isEmpty: HasTaskState = {
          microTask: counts['microTask'] > 0,
          macroTask: counts['macroTask'] > 0,
          eventTask: counts['eventTask'] > 0,
          change: type
        };
        this.hasTask(this.zone, isEmpty);
      }
    }
  }

  class ZoneTask<T extends TaskType> implements Task {
    public type: T;
    public source: string;
    public invoke: Function;
    public callback: Function;
    public data: TaskData | undefined;
    public scheduleFn: ((task: Task) => void) | undefined;
    public cancelFn: ((task: Task) => void) | undefined;
    _zone: Zone | null = null;
    public runCount: number = 0;
    _zoneDelegates: ZoneDelegate[] | null = null;
    _state: TaskState = 'notScheduled';

    constructor(
      type: T,
      source: string,
      callback: Function,
      options: TaskData | undefined,
      scheduleFn: ((task: Task) => void) | undefined,
      cancelFn: ((task: Task) => void) | undefined
    ) {
      this.type = type;
      this.source = source;
      this.data = options;
      this.scheduleFn = scheduleFn;
      this.cancelFn = cancelFn;
      this.callback = callback;
      const self = this;
      if (type === eventTask && options && (options as any).useG) {
        this.invoke = ZoneTask.invokeTask;
      } else {
        this.invoke = function () {
          return ZoneTask.invokeTask.call(global, self, this, <any>arguments);
        };
      }
    }

    /**
     * 执行任务（依托Zone的delegate来最终完成的）
     */
    static invokeTask(task: any, target: any, args: any): any {
      if (!task) {
        task = this;
      }
      _numberOfNestedTaskFrames++;
      try {
        task.runCount++;
        return task.zone.runTask(task, target, args);
      } finally {
        // 只剩一个TaskFrame，将所有队列中的MicroTask执行掉
        if (_numberOfNestedTaskFrames == 1) {
          drainMicroTaskQueue();
        }
        _numberOfNestedTaskFrames--;
      }
    }

    get zone(): Zone {
      return this._zone!;
    }

    get state(): TaskState {
      return this._state;
    }

    public cancelScheduleRequest() {
      this._transitionTo(notScheduled, scheduling);
    }

    /**
     * 改变task的状态
     * 用fromState来验证前一个状态，确保状态切换无误
     */
    _transitionTo(toState: TaskState, fromState1: TaskState, fromState2?: TaskState) {
      if (this._state === fromState1 || this._state === fromState2) {
        this._state = toState;
        if (toState == notScheduled) {
          this._zoneDelegates = null;
        }
      } else {
        throw new Error(`${this.type} '${this.source}': can not transition to '${
          toState}', expecting state '${fromState1}'${
          fromState2 ? ' or \'' + fromState2 + '\'' : ''}, was '${this._state}'.`);
      }
    }

    public toString() {
      if (this.data && typeof this.data.handleId !== 'undefined') {
        return this.data.handleId;
      } else {
        return Object.prototype.toString.call(this);
      }
    }

    public toJSON() {
      return {
        type: this.type,
        state: this.state,
        source: this.source,
        zone: this.zone.name,
        runCount: this.runCount
      };
    }
  }

  //////////////////////////////////////////////////////
  //////////////////////////////////////////////////////
  ///  MICROTASK QUEUE
  //////////////////////////////////////////////////////
  //////////////////////////////////////////////////////
  const symbolSetTimeout = __symbol__('setTimeout');
  const symbolPromise = __symbol__('Promise');
  const symbolThen = __symbol__('then');
  let _microTaskQueue: Task[] = [];
  let _isDrainingMicrotaskQueue: boolean = false;
  let nativeMicroTaskQueuePromise: any;

  /**
   * 安排一个microTask到队列中去
   * 对于MicroTask的执行方式，首选Promise，然后才是setTimeout
   */
  function scheduleMicroTask(task?: MicroTask) {
    // 如果没有任何任务在运行，并且队列中也没有任务了，那就要手动去触发执行，否则就只会不断地往队列里面塞任务
    if (_numberOfNestedTaskFrames === 0 && _microTaskQueue.length === 0) {
      if (!nativeMicroTaskQueuePromise) {
        if (global[symbolPromise]) {
          nativeMicroTaskQueuePromise = global[symbolPromise].resolve(0);
        }
      }
      if (nativeMicroTaskQueuePromise) {
        let nativeThen = nativeMicroTaskQueuePromise[symbolThen];
        if (!nativeThen) {
          nativeThen = nativeMicroTaskQueuePromise['then'];
        }
        nativeThen.call(nativeMicroTaskQueuePromise, drainMicroTaskQueue);
      } else {
        global[symbolSetTimeout](drainMicroTaskQueue, 0);
      }
    }
    task && _microTaskQueue.push(task);
  }

  /**
   * 处理队列中所有MicroTask
   */
  function drainMicroTaskQueue() {
    // 记录是否正在执行的状态
    if (!_isDrainingMicrotaskQueue) {
      _isDrainingMicrotaskQueue = true;
      /**
       * 处理过程中，可能会产生额外的microTask，所以要用while来处理!!!
       */
      while (_microTaskQueue.length) {
        const queue = _microTaskQueue;
        _microTaskQueue = [];
        for (let i = 0; i < queue.length; i++) {
          const task = queue[i];
          try {
            task.zone.runTask(task, null, null);
          } catch (error) {
            _api.onUnhandledError(error);
          }
        }
      }
      _api.microtaskDrainDone();
      _isDrainingMicrotaskQueue = false;
    }
  }

  //////////////////////////////////////////////////////
  //////////////////////////////////////////////////////
  ///  BOOTSTRAP
  //////////////////////////////////////////////////////
  //////////////////////////////////////////////////////

  const NO_ZONE = {name: 'NO ZONE'};
  const notScheduled: 'notScheduled' = 'notScheduled'
    , scheduling: 'scheduling' = 'scheduling'
    , scheduled: 'scheduled' = 'scheduled'
    , running: 'running' = 'running'
    , canceling: 'canceling' = 'canceling'
    , unknown: 'unknown' = 'unknown';
  const microTask: 'microTask' = 'microTask'
    , macroTask: 'macroTask' = 'macroTask'
    , eventTask: 'eventTask' = 'eventTask';

  const patches: { [key: string]: any } = {};

  const noop = (): void => undefined;
  const _api: _ZonePrivate = {
    symbol: __symbol__,
    currentZoneFrame: () => _currentZoneFrame,
    onUnhandledError: noop,
    microtaskDrainDone: noop,
    scheduleMicroTask: scheduleMicroTask,
    showUncaughtError: () => !(Zone as any)[__symbol__('ignoreConsoleErrorUncaughtError')],
    patchEventTarget: () => [],
    patchOnProperties: noop,
    patchMethod: () => noop,
    bindArguments: () => (null as any),
    setNativePromise: (NativePromise: any) => {
      // sometimes NativePromise.resolve static function
      // is not ready yet, (such as core-js/es6.promise)
      // so we need to check here.
      if (NativePromise && typeof NativePromise.resolve === 'function') {
        nativeMicroTaskQueuePromise = NativePromise.resolve(0);
      }
    },
  };
  // 当前正在处理的Zone
  let _currentZoneFrame: _ZoneFrame = {parent: null, zone: new Zone(null, null)};
  // 当前的任务
  let _currentTask: Task | null = null;
  let _numberOfNestedTaskFrames = 0;

  function __symbol__(name: string) {
    return '__zone_symbol__' + name;
  }

  performanceMeasure('Zone', 'Zone');
  return global['Zone'] = Zone;
})(typeof window !== 'undefined' && window || typeof self !== 'undefined' && self || global);

declare module window {
  export const Zone: any
}
