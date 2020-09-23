import { ILogger } from 'the-logger';
import { Promise } from 'the-promise';
import _ from 'the-lodash';
import axios from 'axios';
import { AxiosResponse } from 'axios';

import dotenv from 'dotenv';
dotenv.config();

interface JobInfo 
{
    name: string;
    seconds: number;
    cb: (...args: any[]) => void;
    preScheduleCb?: (...args: any[]) => void;
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
}

export class WorldviousClient
{
    private logger : ILogger;
    private name : string;
    private version : string;
    private enabled = true;
    private id? : string;
    private closed = false;
    private isFirstErrorReported = false;

    private timers : Record<string, NodeJS.Timeout> = {};
    private jobs : Record<string, JobInfo> = {};
    private jobRuntime : Record<string, JobRuntime> = {};

    private counters = {};
    private metrics = {};
    private errors : Record<string, ErrorInfo> = {};

    constructor(logger : ILogger, name: string, version: string)
    {
        this.logger = logger.sublogger("Worldvious");
        this.name = name;
        this.version = version;

        this.id = process.env.WORLDVIOUS_ID;
        if (!this.id) {
            this.logger.warn("NO WORLDVIOUS_ID Not Set. Disabling.");
            this.enabled = false;
        }

        if (!process.env.WORLDVIOUS_URL) {
            this.logger.warn("NO WORLDVIOUS_URL Set. Disabling.");
            this.enabled = false;
        }

    }

    init() : Promise<any>
    {
        return Promise.resolve()
            .then(() => this._schedule())
            .then(() => this._runJobNow(ReportActions.VersionCheck));
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

    acceptError(error: any)
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
            this._runJobNow(ReportActions.ReportError);
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

    private _runJobNow(name : string) : Promise<any> | null
    {
        return this._runJob(name, true);
    }

    private _schedule()
    {
        this._register(ReportActions.VersionCheck, 60 * 60, 'WORLDVIOUS_VERSION_CHECK_TIMEOUT', () => {
            return this._checkVersion();
        });

        this._register(ReportActions.ReportError, 1 * 60, 'WORLDVIOUS_ERROR_REPORT_TIMEOUT', () => {
            return this._reportError();
        }, () => {
            this.isFirstErrorReported = false;
        });

        this._register(ReportActions.ReportCounters, 60 * 60, 'WORLDVIOUS_COUNTERS_REPORT_TIMEOUT', () => {
            return this._reportCounters();
        });

        for(let name of _.keys(this.jobs))
        {
            this._runJob(name, false);
        }
    }


    private _checkVersion()
    {
        const data = this._makeNewData();
        data.version = this.version;
        return this._request('report/version', data);
    }

    private _reportCounters()
    {
        const data = this._makeNewData();
        data.counters = this.counters;
        data.metrics = this.metrics;
        this.logger.info("****************** _reportCounters ", data);
        return this._request('report/counters', data);
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
                    this.logger.error("%s failed. reason: ",name, reason);
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

    private _register(name: string, seconds: number, overrideEnvName: string, cb: (...args: any[]) => void, preScheduleCb?: (...args: any[]) => void)
    {
        if (overrideEnvName) {
            const overrideValue = process.env[overrideEnvName];
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

    private _request(url: string, data: Record<string, any>) : Promise<AxiosResponse>
    {
        const fullUrl = `${process.env.WORLDVIOUS_URL}/${url}`;

        this.logger.info("Requesting %s...", fullUrl, data);
        return Promise.construct<AxiosResponse>((resolve, reject) => {
            axios.post(fullUrl, data)
                .then(result => {
                    this.logger.info("Done %s.", fullUrl, result.data);
                    resolve(result.data)
                })
                .catch(reason => {
                    this.logger.error("Failed %s.", fullUrl, reason);
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