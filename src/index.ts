import { ILogger } from 'the-logger';
import { Promise, Resolvable, BasePromise } from 'the-promise';
import _ from 'the-lodash';
import axios from 'axios';

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

enum NotificationKind {
    NewVersion = 'new-version',
    FeedbackRequest = 'feedback-request',
    Message = 'message'
}

export interface VersionInfo
{
    kind: string;
    name: string;
    version: string;
    changes: string[];
    features: string[];
    url: string;
}

export interface FeedbackQuestion
{
    id: string;
    kind: string;
    text: string;
    options?: string;
}

export interface FeedbackRequest
{
    kind: string;
    id: string;
    questions: FeedbackQuestion[];
}

export type NotificationItem = VersionInfo | FeedbackRequest;

export interface VersionInfoResult
{
    notifications: NotificationItem[];
}

export type NotificationsChangeCallback = (notifications: NotificationItem[]) => Resolvable<any>;

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
    private _notificationItems: NotificationItem[] = [];
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

        for(let config of _.values(this.jobConfigs))
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
        
        for(let name of _.keys(this.jobConfigs))
        {
            const config = this.jobConfigs[name];
            this.logger.info("Job: %s, Enabled: %s.", name, config.enabled);
        }
    }

    get notificationItems() : NotificationItem[] {
        return this._notificationItems;
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
                return Promise.serial(_.keys(this.jobConfigs), name => {
                    const config = this.jobConfigs[name];
                    return this._runJob(name, config.shouldStartImmediately);
                })
            });
    }

    close()
    {
        this.logger.info("Closing...")
        this.closed = true;
        for(let timer of _.values(this.timers))
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

    reportFeedback(id: string, answers: any)
    {
        const data : Record<string, any> = {}
        data.id = this.id;
        data.feedbackId = id;
        data.answers = answers;
        return this._request('report/feedback', data);
    }

    private _trigger(cb : NotificationsChangeCallback)
    {
        try
        {
            const res = cb(this._notificationItems);
            BasePromise.resolve(res)
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
        return this._request('report/version', data)
            .then(result => {
                const versionInfoResult = <VersionInfoResult> result;
                this._activateNewVersionInfo(versionInfoResult);
            });
    }

    private _activateNewVersionInfo(versionInfoResult : VersionInfoResult)
    {
        for(let item of versionInfoResult.notifications)
        {
            if (item.kind == NotificationKind.NewVersion)
            {
                const newVersionRequest = <VersionInfo> item;
                this.logger.info("New version (%s %s) is available. Download from: %s.",
                    newVersionRequest.name,
                    newVersionRequest.version,
                    newVersionRequest.url);
            }
        }

        this._notificationItems = versionInfoResult.notifications;
        for(let cb of this._notificationsChangeListeners)
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

        for(let errorInfo of _.values(this.errors))
        {
            const data = this._makeNewData();
            data.version = this.version;
            data.error = errorInfo.error;
            data.count = errorInfo.count;
            payloads.push(data);
        }
        this.errors = {};

        return Promise.serial(payloads, data => {
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

    private _request(url: string, data: Record<string, any>) : Promise<any>
    {
        const fullUrl = `${process.env.WORLDVIOUS_URL}/${url}`;

        this.logger.silly("Requesting %s...", fullUrl, data);
        return Promise.construct<any>((resolve, reject) => {
            axios.post(fullUrl, data)
                .then(result => {
                    this.logger.silly("Done %s.", fullUrl, result.data);
                    resolve(result.data)
                })
                .catch(reason => {
                    this.logger.error("Failed %s. %s", fullUrl, reason.message);
                    reject(reason);
                });
        })
    }

    private _makeNewData() : Record<string, any>
    {
        const data : Record<string, any> = {}
        data.id = this.id;
        data.process = this.name;
        return data;
    }

}