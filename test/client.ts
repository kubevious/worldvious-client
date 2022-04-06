import 'mocha';
import should = require('should');

import _ from 'the-lodash';
import { Promise } from 'the-promise';
import { setupLogger, LoggerOptions } from 'the-logger';
const loggerOptions = new LoggerOptions().enableFile(false).pretty(true);
const logger = setupLogger('test', loggerOptions);
const serverLogger = setupLogger('SERVER', loggerOptions);

import dotenv from 'dotenv';
dotenv.config();

const TEST_SERVER_PORT=4444

interface ServerMockData {
    requests: Record<string, any>;
    requestCounter: Record<string, number>;
    server?: any;
    shouldRequestNewVersion: boolean;
    shouldRequestFeedback: boolean;
};

const SERVER_DATA : ServerMockData = {
    requests: {},
    requestCounter: {},
    server: null,
    shouldRequestNewVersion: false,
    shouldRequestFeedback: false
};

function registerRequest(name: string, body: any)
{
    SERVER_DATA.requests[name] = body;
    if (SERVER_DATA.requestCounter[name]) {
        SERVER_DATA.requestCounter[name] = SERVER_DATA.requestCounter[name] + 1;
    } else {
        SERVER_DATA.requestCounter[name] = 1;
    }
}

import { WorldviousClient } from '../src';

let client: WorldviousClient;

describe('worldvious', () => {

    beforeEach(() => {
        process.env.WORLDVIOUS_URL=`http://localhost:${TEST_SERVER_PORT}/api/v1/oss`
        process.env.WORLDVIOUS_ID='123e4567-e89b-12d3-a456-426614174000'
        SERVER_DATA.shouldRequestNewVersion = false;
        SERVER_DATA.shouldRequestFeedback = false;
        delete process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT;
        delete process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT;
        delete process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT;
        delete process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT;
        delete process.env.WORLDVIOUS_VERSION_CHECK_DISABLE;
        delete process.env.WORLDVIOUS_ERROR_REPORT_DISABLE;
        delete process.env.WORLDVIOUS_COUNTERS_REPORT_DISABLE;
        delete process.env.WORLDVIOUS_METRICS_REPORT_DISABLE;

        const express = require("express");
        const bodyParser = require('body-parser');
        const app = express();

        app.use(bodyParser.json())

        app.post('/api/v1/oss/report/version', (req: any, res: any, next: any) => {
            serverLogger.info("REPORT VERSION, body: ", req.body );
            registerRequest('report-version', req.body);

            const notifications : any[] = [];
            
            if (SERVER_DATA.shouldRequestNewVersion)
            {
                notifications.push(
                    {
                        "kind": "new-version",
                        "name": "Kubevious",
                        "version": "v1.2.3",
                        "url": "https://github.com/kubevious/kubevious",
                        "changes": [
                            "change-1",
                            "change-2",
                            "change-3",
                        ],
                        "features": [
                            "feature-1",
                            "feature-2",
                            "feature-3",
                        ]
                    });
            }

            if (SERVER_DATA.shouldRequestFeedback)
            {
                notifications.push(
                    {
                        "kind": "feedback-request",
                        "id": "7654e321-e89b-12d3-a456-426614174000",
                        "questions": [
                            {
                                "id": "ease-of-use",
                                "kind": "rate",
                                "text": "How do you like the easy of use?"
                            }
                        ]
                    });
            }

            const data = {
                notifications: notifications
            };

            res.json(data);
        });

        app.post('/api/v1/oss/report/error', (req: any, res: any, next: any) => {
            serverLogger.info("REPORT ERROR, body: ", req.body );
            registerRequest('report-error', req.body);
            res.json({
            });
        });


        app.post('/api/v1/oss/report/counters', (req: any, res: any, next: any) => {
            serverLogger.info("REPORT COUNTERS, body: ", req.body );
            registerRequest('report-counters', req.body);
            res.json({
            });
        });

        app.post('/api/v1/oss/report/metrics', (req: any, res: any, next: any) => {
            serverLogger.info("REPORT METRICS, body: ", req.body );
            registerRequest('report-metrics', req.body);
            res.json({
            });
        });
        
        SERVER_DATA.requests = {};
         
        return Promise.construct((resolve, reject) => {
            SERVER_DATA.server = app.listen(TEST_SERVER_PORT, () => {
                console.log(`Server running on port ${TEST_SERVER_PORT}`);
                resolve();
            });
        })
        // .then(() => Promise.timeout(1000))
    });

    afterEach(() => {
        if (client) {
            client.close();
        }
        SERVER_DATA.server!.close();
        SERVER_DATA.requests = {};
        SERVER_DATA.requestCounter = {};
        SERVER_DATA.server = null;
    });

    it('constructor', () => {
        client = new WorldviousClient(logger, "kubevious", 'v1.2.3');
        return Promise.resolve()
    });

    it('init', () => {
        client = new WorldviousClient(logger, "kubevious", 'v1.2.3');
        return Promise.resolve()
            .then(() => client.init())
    });


    it('check_version_new_version_available', () => {
        SERVER_DATA.shouldRequestNewVersion = true;

        client = new WorldviousClient(logger, "kubevious", 'v1.2.3');
        let notifications : any[];
        client.onNotificationsChanged((x) => {
            notifications = x;
        })
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                should(SERVER_DATA.requests['report-version']).be.eql({
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    process: "kubevious",
                    version: "v1.2.3"
                })
            })
            .then(() => {
                const version = _.find(notifications, x => x.kind == 'new-version');
                should(version).be.ok();
                should(version.name).be.equal("Kubevious");
                should(version.version).be.equal("v1.2.3");
                should(version.url).be.equal("https://github.com/kubevious/kubevious");
                should(version.changes).be.an.Array();
                should(version.features).be.an.Array()
                
                should(notifications.length).equal(1);
            })
    });

    it('check_version_no_version_available', () => {
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        let notifications : any[] = [];
        client.onNotificationsChanged((x) => {
            notifications = x;
        })
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                should(SERVER_DATA.requests['report-version']).be.eql({
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    process: "parser",
                    version: "v7.8.9"
                })
                return Promise.timeout(100);
            })
            .then(() => {
                const version = _.find(notifications, x => x.kind == 'new-version');
                should(version).not.be.ok();
                should(notifications.length).equal(0);
            })
    });


    it('check_version_feedback_requested', () => {
        SERVER_DATA.shouldRequestFeedback = true;

        client = new WorldviousClient(logger, "kubevious", 'v1.2.3');
        let notifications : any[];
        client.onNotificationsChanged((x) => {
            notifications = x;
        })
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                should(SERVER_DATA.requests['report-version']).be.eql({
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    process: "kubevious",
                    version: "v1.2.3"
                })
            })
            .then(() => {
                const feedback = _.find(notifications, x => x.kind == 'feedback-request');
                should(feedback).be.ok();
                should(notifications.length).equal(1);
            })
    });


    it('check_version_timeout', () => {
        process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT = '1';
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => Promise.timeout(5500))
            .then(() => {
                logger.info("Test end.");
                should(SERVER_DATA.requestCounter['report-version']).be.equal(6);
            })
    })
    .timeout(10 * 1000);


    it('error_report_one', () => {
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                try
                {
                    throw new Error("Something bad happened");
                }
                catch(reason)
                {
                    client.acceptError(reason);
                }
                
            })
            .then(() => Promise.timeout(100))
            .then(() => {
                should(SERVER_DATA.requestCounter['report-error']).be.equal(1);

                const response = SERVER_DATA.requests['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.error).be.a.String();
            })
    });


    it('error_report_multiple', () => {
        process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT = '3';

        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                for(let i = 0; i < 10; i++)
                {
                    try
                    {
                        throw new Error(`Something bad happened - ${1}`);
                    }
                    catch(reason)
                    {
                        client.acceptError(reason);
                    }
                }
            })
            .then(() => Promise.timeout(100))
            .then(() => {
                should(SERVER_DATA.requestCounter['report-error']).be.equal(1);

                const response = SERVER_DATA.requests['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.count).be.equal(1);
                should(response.error).be.a.String();
                should((<string>response.error).includes("Something bad happened"))
            })
            .then(() => Promise.timeout(3000))
            .then(() => {
                should(SERVER_DATA.requestCounter['report-error']).be.equal(2);

                const response = SERVER_DATA.requests['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.count).be.equal(9);
                should(response.error).be.a.String();
                should((<string>response.error).includes("Something bad happened"))

            })
            .then(() => {
                for(let i = 0; i < 5; i++)
                {
                    try
                    {
                        throw new Error(`One More Error - ${1}`);
                    }
                    catch(reason)
                    {
                        client.acceptError(reason);
                    }
                }
            })
            .then(() => Promise.timeout(100))
            .then(() => {
                should(SERVER_DATA.requestCounter['report-error']).be.equal(3);

                const response = SERVER_DATA.requests['report-error'];

                should((<string>response.error).includes("One More Error"))

            })
            .then(() => Promise.timeout(3000))
            .then(() => {
                should(SERVER_DATA.requestCounter['report-error']).be.equal(4);

                const response = SERVER_DATA.requests['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.error).be.a.String();
                should(response.count).be.equal(4);
                should((<string>response.error).includes("One More Error"))
            })
    })
    .timeout(20 * 1000);


    it('report_counters', () => {
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '2';
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptCounters({
                    foo1: 'bar1'
                });
            })
            .then(() => Promise.timeout(6500))
            .then(() => {
                logger.info("Test end.");
                should(SERVER_DATA.requestCounter['report-counters']).be.equal(3);

                const requestBody = SERVER_DATA.requests['report-counters'];
                should(requestBody.counters).be.eql({
                    foo1: 'bar1'
                });

            })
            .then(() => {
                delete process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT;
            })
    })
    .timeout(10 * 1000);


    it('report_metrics', () => {
        process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT = '2';
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptMetrics({
                    foo2: 'bar2'
                });
            })
            .then(() => Promise.timeout(6500))
            .then(() => {
                logger.info("Test end.");
                should(SERVER_DATA.requestCounter['report-metrics']).be.equal(3);

                const requestBody = SERVER_DATA.requests['report-metrics'];
                should(requestBody.metrics).be.eql({
                    foo2: 'bar2'
                });

            })
            .then(() => {
                delete process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT;
            })
    })
    .timeout(10 * 1000);


    it('disabled_reporting_no_url', () => {
        process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT = '1';
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT = '1';
        delete process.env.WORLDVIOUS_URL;

        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptCounters({
                    foo1: 'bar1'
                });
                client.acceptMetrics({
                    foo2: 'bar2'
                });
                try
                {
                    throw new Error("Some Error")
                }
                catch(reason)
                {
                    client.acceptError(reason);
                }
            })
            .then(() => Promise.timeout(3000))
            .then(() => {
                logger.info("Test end.");
                logger.info("SERVER_DATA: ", SERVER_DATA.requests);

                should(_.keys(SERVER_DATA.requestCounter).length).be.equal(0);
            })
    })
    .timeout(10 * 1000);



    it('disabled_counters_report', () => {
        process.env.WORLDVIOUS_COUNTERS_REPORT_DISABLE = 'true';

        process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT = '1';
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT = '1';

        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptCounters({
                    foo1: 'bar1'
                });
                client.acceptMetrics({
                    foo2: 'bar2'
                });
                try
                {
                    throw new Error("Some Error")
                }
                catch(reason)
                {
                    client.acceptError(reason);
                }
            })
            .then(() => Promise.timeout(3 * 1000))
            .then(() => {
                logger.info("Test end.");
                logger.info("SERVER_DATA: ", SERVER_DATA.requests);
                should(SERVER_DATA.requests['report-version']).be.ok();
                should(SERVER_DATA.requests['report-error']).be.ok();
                should(SERVER_DATA.requests['report-metrics']).be.ok();
                should(SERVER_DATA.requests['report-counters']).not.be.ok();
            })
    })
    .timeout(10 * 1000);


    it('disabled_metrics_report', () => {
        process.env.WORLDVIOUS_METRICS_REPORT_DISABLE = 'true';

        process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT = '1';
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT = '1';

        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptCounters({
                    foo1: 'bar1'
                });
                client.acceptMetrics({
                    foo2: 'bar2'
                });
                try
                {
                    throw new Error("Some Error")
                }
                catch(reason)
                {
                    client.acceptError(reason);
                }
            })
            .then(() => Promise.timeout(3 * 1000))
            .then(() => {
                logger.info("Test end.");
                logger.info("SERVER_DATA: ", SERVER_DATA.requests);

                should(SERVER_DATA.requests['report-version']).be.ok();
                should(SERVER_DATA.requests['report-error']).be.ok();
                should(SERVER_DATA.requests['report-counters']).be.ok();
                should(SERVER_DATA.requests['report-metrics']).not.be.ok();
            })
    })
    .timeout(10 * 1000);


    it('disabled_version_check_report', () => {
        process.env.WORLDVIOUS_VERSION_CHECK_DISABLE = 'true';

        process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT = '1';
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT = '1';
        process.env.WORLDVIOUS_METRICS_REPORT_TIMEOUT = '1';

        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                client.acceptCounters({
                    foo1: 'bar1'
                });
                client.acceptMetrics({
                    foo2: 'bar2'
                });
                try
                {
                    throw new Error("Some Error")
                }
                catch(reason)
                {
                    client.acceptError(reason);
                }
            })
            .then(() => Promise.timeout(3 * 1000))
            .then(() => {
                logger.info("Test end.");
                logger.info("SERVER_DATA: ", SERVER_DATA.requests);

                should(SERVER_DATA.requests['report-version']).not.be.ok();
                should(SERVER_DATA.requests['report-error']).be.ok();
                should(SERVER_DATA.requests['report-counters']).be.ok();
                should(SERVER_DATA.requests['report-metrics']).be.ok();
            })
    })
    .timeout(10 * 1000);

});
