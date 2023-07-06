import { ILogger } from 'the-logger';
import { MyPromise, Resolvable } from 'the-promise';
import _ from 'the-lodash';

import { HttpClient  } from '@kubevious/http-client';
import { WorldviousVersionInfoResult,
         WorldviousNotificationKind,
         WorldviousNewVersionInfo,
         WorldviousFeedbackSubmitData
        } from '@kubevious/ui-middleware/dist/services/worldvious';

import dotenv from 'dotenv';
dotenv.config();

interface JobInfo 
{
    name: string;
    seconds: number;
    cb: (...args: any[]) => void;
    preScheduleCb?: (...args: any[]) => void;
}

interface JobConfig 
{
    enabled: boolean
    delaySeconds: number
    disableEnvName: string
    overrideEnvName: string
    shouldStartImmediately: boolean
}

interface JobRuntime 
{
    isRunning: boolean
}

interface ErrorInfo
{
    error: string;
    count: number;
}

enum ReportActions {
    VersionCheck = 'version-check',
    ReportError = 'report-error',
    ReportCounters = 'report-counters',
    ReportMetrics = 'report-metrics',
}


export type NotificationsChangeCallback = (result: WorldviousVersionInfoResult) => Resolvable<any>;

export class WorldviousClient
{
    private logger : ILogger;
    private name : string;
    private version : string;
    private enabled = true;
    private id? : string;
    private closed = false;
    private isFirstErrorReported = false;

    private jobConfigs : Record<string, JobConfig> = {};
    private timers : Record<string, NodeJS.Timeout> = {};
    private jobs : Record<string, JobInfo> = {};
    private jobRuntime : Record<string, JobRuntime> = {};

    private counters = [];
    private metrics = [];
    private errors : Record<string, ErrorInfo> = {};
    private _versionCheckResult: WorldviousVersionInfoResult = {
        notifications: []
    };
    private _notificationsChangeListeners : NotificationsChangeCallback[] = [];

    constructor(logger : ILogger, name: string, version: string)
    {
        this.logger = logger.sublogger("Worldvious");
        this.name = name;
        this.version = version;

        this.jobConfigs[ReportActions.VersionCheck] = {
            delaySeconds: 60 * 60,
            enabled: true,
            disableEnvName: 'WORLDVIOUS_VERSION_CHECK_DISABLE',
            overrideEnvName: 'WORLDVIOUS_VERSION_CHECK_TIMEOUT',
            shouldStartImmediately: true
        }

        this.jobConfigs[ReportActions.ReportError] = {
            delaySeconds: 1 * 60,
            enabled: true,
            disableEnvName: 'WORLDVIOUS_ERROR_REPORT_DISABLE',
            overrideEnvName: 'WORLDVIOUS_ERROR_REPORT_TIMEOUT',
            shouldStartImmediately: false
        }

        this.jobConfigs[ReportActions.ReportCounters] = {
            delaySeconds: 60 * 60,
            enabled: true,
            disableEnvName: 'WORLDVIOUS_COUNTERS_REPORT_DISABLE',
            overrideEnvName: 'WORLDVIOUS_COUNTERS_REPORT_TIMEOUT',
            shouldStartImmediately: false
        }

        this.jobConfigs[ReportActions.ReportMetrics] = {
            delaySeconds: 60 * 60,
            enabled: true,
            disableEnvName: 'WORLDVIOUS_METRICS_REPORT_DISABLE',
            overrideEnvName: 'WORLDVIOUS_METRICS_REPORT_TIMEOUT',
            shouldStartImmediately: false
        }
        this.id = process.env.WORLDVIOUS_ID;

        if (this.enabled) {
            if (!this.id) {
                this.logger.warn("No WORLDVIOUS_ID Not Set. Disabling.");
                this.enabled = false;
            }
        }
        if (this.enabled) {
            if (!process.env.WORLDVIOUS_URL) {
                this.logger.warn("No WORLDVIOUS_URL Set. Disabling.");
                this.enabled = false;
            }
        }

        for(const config of _.values(this.jobConfigs))
        {
            if (!this.enabled) {
                config.enabled = false;
            } else {
                if (process.env[config.disableEnvName])
                {
                    config.enabled = false;
                }
            }
        }
        
        for(const name of _.keys(this.jobConfigs))
        {
            const config = this.jobConfigs[name];
            this.logger.info("Job: %s, Enabled: %s.", name, config.enabled);
        }
    }

    get versionCheckResult() : WorldviousVersionInfoResult {
        return this._versionCheckResult;
    }

    onNotificationsChanged(cb : NotificationsChangeCallback)
    {
        this._notificationsChangeListeners.push(cb);
        this._trigger(cb);
    }

    init() : Promise<any>
    {
        return Promise.resolve()
            .then(() => this._schedule())
            .then(() => {
                return MyPromise.serial(_.keys(this.jobConfigs), name => {
                    const config = this.jobConfigs[name];
                    return this._runJob(name, config.shouldStartImmediately);
                })
            });
    }

    close()
    {
        this.logger.info("Closing...")
        this.closed = true;
        for(const timer of _.values(this.timers))
        {
            clearTimeout(timer);
        }
        this.timers = {};
    }

    acceptError(error: any) : Resolvable<any>
    {
        const errorStr = this._getErrorString(error);
        if (this.errors[errorStr]) {
            this.errors[errorStr].count = this.errors[errorStr].count + 1;
        } else {
            this.errors[errorStr] = {
                error: errorStr,
                count: 1
            };
        }

        if (!this.isFirstErrorReported) {
            this.isFirstErrorReported = true;
            return this._runJob(ReportActions.ReportError, true);
        }
    }

    acceptCounters(value: any)
    {
        this.counters = value;
    }

    acceptMetrics(value: any)
    {
        this.metrics = value;
    }

    reportFeedback(data: WorldviousFeedbackSubmitData)
    {
        if (!this.id) {
            return
        }
        const body  = {
            id: this.id,
            feedbackId: data.id,
            answers: data.answers
        }
        return this._request('report/feedback', body);
    }

    private _trigger(cb : NotificationsChangeCallback)
    {
        try
        {
            Promise.resolve(null)
                .then(() => cb(this._versionCheckResult))
                .catch(reason => {
                    this.logger.error("ERROR: ", reason);
                })
                .then(() => null);
        }
        catch(reason)
        {
            this.logger.error("ERROR: ", reason);
        }
    }

    private _schedule()
    {
        this._register(ReportActions.VersionCheck, () => {
            return this._checkVersion();
        });

        this._register(ReportActions.ReportError, () => {
            return this._reportError();
        }, () => {
            this.isFirstErrorReported = false;
        });

        this._register(ReportActions.ReportCounters, () => {
            return this._reportCounters();
        });

        this._register(ReportActions.ReportMetrics, () => {
            return this._reportMetrics();
        });
    }

    private _checkVersion()
    {
        const data = this._makeNewData();
        data.version = this.version;
        return this._request<WorldviousVersionInfoResult>('report/version', data)
            .then(result => {
                this._activateNewVersionInfo(result);
            });
    }

    private _activateNewVersionInfo(result : WorldviousVersionInfoResult)
    {
        for(const item of result.notifications)
        {
            if (item.kind == WorldviousNotificationKind.newVersion)
            {
                const newVersionRequest = <WorldviousNewVersionInfo> item;
                this.logger.info("New version (%s %s) is available. Download from: %s.",
                    newVersionRequest.name,
                    newVersionRequest.version,
                    newVersionRequest.url);
            }
        }

        this._versionCheckResult = result;
        for(const cb of this._notificationsChangeListeners)
        {
            this._trigger(cb);
        }
    }

    private _reportCounters()
    {
        const data = this._makeNewData();
        data.counters = this.counters;
        return this._request('report/counters', data);
    }

    private _reportMetrics()
    {
        const data = this._makeNewData();
        data.metrics = this.metrics;
        return this._request('report/metrics', data);
    }

    private _reportError()
    {
        if (_.keys(this.errors).length == 0) {
            return;
        }

        const payloads : any[] = [];

        for(const errorInfo of _.values(this.errors))
        {
            const data = this._makeNewData();
            data.version = this.version;
            data.error = errorInfo.error;
            data.count = errorInfo.count;
            payloads.push(data);
        }
        this.errors = {};

        return MyPromise.serial(payloads, data => {
            return this._request('report/error', data);
        });
    }

    private _getErrorString(error : any)
    {
        if (_.isNullOrUndefined(error)) {
            return "UNDEFINED ERROR";
        }
        if (error.stack) {
            return error.stack;
        }
        return error.toString();
    }


    private _runJob(name : string, executeNow: boolean) : Promise<any> | null
    {
        if (this.closed) {
            return null;
        }

        const config = this.jobConfigs[name];
        if (!config.enabled) {
            return Promise.resolve();
        }

        const job = this.jobs[name];
        if (!job) {
            this.logger.error("Unknown job: %s.", name);
            return null;
        }

        const handler = () => {
            if (this.jobRuntime[name].isRunning) {
                this._runJob(name, false);
                return null;
            }
            this.jobRuntime[name].isRunning = true;
            this.logger.info("Running %s...", name);
            try
            {
                const res = job.cb();
                return Promise.resolve(res)
                    .then(() => {
                        this.logger.info("Completed %s", name);
                    })
                    .catch(reason => {
                        this.logger.error("%s failed. reason: %s",name, reason.message);
                    })
                    .then(() => {
                        this.jobRuntime[name].isRunning = false;
                        this._runJob(name, false);
                    })
            }
            catch(reason)
            {
                this.logger.error("%s failed. reason: ",name, reason);
                return Promise.resolve();
            }
        };

        if (executeNow)
        {
            this._stopScheduledJob(name);
            return handler();
        }
        else
        {
            if (!this.timers[name]) {
                if (job.preScheduleCb) {
                    job.preScheduleCb!();
                }
                const timer = setTimeout(() => {
                    delete this.timers[name];
                    handler();
                    return null;
                }, job.seconds * 1000);
                this.timers[name] = timer;
            }
        }

        return null;
    }

    private _stopScheduledJob(name: string)
    {
        const timer = this.timers[name];
        if (timer)
        {
            clearTimeout(timer);
            delete this.timers[name];
        }
    }

    private _register(name: string, cb: (...args: any[]) => void, preScheduleCb?: (...args: any[]) => void)
    {
        const config = this.jobConfigs[name];
        if (!config.enabled) {
            return;
        }

        let seconds = config.delaySeconds;
        if (config.overrideEnvName) {
            const overrideValue = process.env[config.overrideEnvName];
            if (overrideValue)
            {
                const parsed = Number.parseInt(overrideValue);
                if (!Number.isNaN(parsed))
                {
                    seconds = parsed;
                }
            }
        }

        this.logger.info("Registered %s. timeout: %ssec.", name, seconds);
        this.jobs[name] = {
            name: name,
            seconds: seconds,
            cb: cb,
            preScheduleCb: preScheduleCb
        }
        this.jobRuntime[name] = {
            isRunning: false
        }
    }

    private _request<T = any>(url: string, data: Record<string, any>)
    {
        const fullUrl = `${process.env.WORLDVIOUS_URL}/${url}`;

        this.logger.silly("Requesting %s...", fullUrl, data);

        const client = new HttpClient();
        return client.post<T>(fullUrl, {}, data)
            .then(result => {
                this.logger.silly("Done %s.", fullUrl, result.data);
                return result.data;
            })
            .catch(reason => {
                this.logger.error("Failed %s. %s", fullUrl, reason.message);
                throw reason;
            });
    }

    private _makeNewData() : Record<string, any>
    {
        const data : Record<string, any> = {}
        data.id = this.id;
        data.process = this.name;
        return data;
    }

}