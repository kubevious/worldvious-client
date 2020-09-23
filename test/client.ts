import 'mocha';
import should = require('should');

import { Promise } from 'the-promise';
import { setupLogger, LoggerOptions } from 'the-logger';
const loggerOptions = new LoggerOptions().enableFile(false).pretty(true);
const logger = setupLogger('test', loggerOptions);
const serverLogger = setupLogger('SERVER', loggerOptions);

import dotenv from 'dotenv';
dotenv.config();

const TEST_SERVER_PORT=4444
process.env.WORLDVIOUS_URL=`http://localhost:${TEST_SERVER_PORT}/api/v1/oss`
process.env.WORLDVIOUS_ID='123e4567-e89b-12d3-a456-426614174000'

interface ServerMockData {
    responses: Record<string, any>;
    responseCounter: Record<string, number>;
    server?: any
};

const SERVER_DATA : ServerMockData = {
    responses: {},
    responseCounter: {},
    server: null
};

function registerRequest(name: string, body: any)
{
    SERVER_DATA.responses[name] = body;
    if (SERVER_DATA.responseCounter[name]) {
        SERVER_DATA.responseCounter[name] = SERVER_DATA.responseCounter[name] + 1;
    } else {
        SERVER_DATA.responseCounter[name] = 1;
    }
}

import { WorldviousClient } from '../src';

let client: WorldviousClient;

describe('worldvious', () => {

    beforeEach(() => {
        var express = require("express");
        var bodyParser = require('body-parser');
        var app = express();

        app.use(bodyParser.json())

        app.post('/api/v1/oss/report/version', (req: any, res: any, next: any) => {
            serverLogger.info("REPORT VERSION, body: ", req.body );
            registerRequest('report-version', req.body);
            res.json({
                "newVersionPresent": true,
                "version": "v1.2.3",
                "url": "https://github.com/kubevious/helm#installing-the-chart-using-helm-v3x"
            });
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
        
        SERVER_DATA.responses = {};
         
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
        SERVER_DATA.responses = {};
        SERVER_DATA.responseCounter = {};
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


    it('check_version_1', () => {
        client = new WorldviousClient(logger, "kubevious", 'v1.2.3');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                should(SERVER_DATA.responses['report-version']).be.eql({
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    process: "kubevious",
                    version: "v1.2.3"
                })
            })
    });

    it('check_version_2', () => {
        client = new WorldviousClient(logger, "parser", 'v7.8.9');
        return Promise.resolve()
            .then(() => client.init())
            .then(() => {
                should(SERVER_DATA.responses['report-version']).be.eql({
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    process: "parser",
                    version: "v7.8.9"
                })
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
                should(SERVER_DATA.responseCounter['report-version']).be.equal(6);
            })
            .then(() => {
                delete process.env.WORLDVIOUS_VERSION_CHECK_TIMEOUT;
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
                should(SERVER_DATA.responseCounter['report-error']).be.equal(1);

                const response = SERVER_DATA.responses['report-error'];

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
                should(SERVER_DATA.responseCounter['report-error']).be.equal(1);

                const response = SERVER_DATA.responses['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.count).be.equal(1);
                should(response.error).be.a.String();
                should((<string>response.error).includes("Something bad happened"))
            })
            .then(() => Promise.timeout(3000))
            .then(() => {
                should(SERVER_DATA.responseCounter['report-error']).be.equal(2);

                const response = SERVER_DATA.responses['report-error'];

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
                should(SERVER_DATA.responseCounter['report-error']).be.equal(3);

                const response = SERVER_DATA.responses['report-error'];

                should((<string>response.error).includes("One More Error"))

            })
            .then(() => Promise.timeout(3000))
            .then(() => {
                should(SERVER_DATA.responseCounter['report-error']).be.equal(4);

                const response = SERVER_DATA.responses['report-error'];

                should(response.id).be.equal("123e4567-e89b-12d3-a456-426614174000");
                should(response.process).be.equal("parser");
                should(response.error).be.a.String();
                should(response.count).be.equal(4);
                should((<string>response.error).includes("One More Error"))
            })
            .then(() => {
                delete process.env.WORLDVIOUS_ERROR_REPORT_TIMEOUT;
            })
    })
    .timeout(20 * 1000);


    it('report_metrics', () => {
        process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT = '2';
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
            })
            .then(() => Promise.timeout(6500))
            .then(() => {
                logger.info("Test end.");
                should(SERVER_DATA.responseCounter['report-counters']).be.equal(3);

                const requestBody = SERVER_DATA.responses['report-counters'];
                should(requestBody.counters).be.eql({
                    foo1: 'bar1'
                });
                should(requestBody.metrics).be.eql({
                    foo2: 'bar2'
                });

            })
            .then(() => {
                delete process.env.WORLDVIOUS_COUNTERS_REPORT_TIMEOUT;
            })
    })
    .timeout(10 * 1000);

});
