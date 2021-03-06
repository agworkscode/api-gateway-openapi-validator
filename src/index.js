const find = require('lodash/find');
const get = require('lodash/get');
const OpenApiLoader = require('./openApiLoader');
const RequestValidator = require('./openApiRequestValidator');
const ResponseValidator = require('./openApiResponseValidator');
const { ValidationError } = require('./errors');
const { isJson } = require('./utils');
const { TYPE_JSON } = require('./constants');

module.exports = class OpenApiValidator {
    constructor(params, lambdaBody) {
        if (!params.apiSpec || !isJson(params.apiSpec)) {
            throw Error('API spec not found or invalid');
        }
        this.apiSpec = params.apiSpec;
        this.contentType = params.contentType || TYPE_JSON;
        this.validateSpec = params.validateSpec || true;
        this.validateRequests = params.validateRequests || false;
        this.validateResponses = params.validateResponses || false;
        this.requestBodyTransformer = params.requestBodyTransformer;
        this.requestPathTransformer = params.requestPathTransformer;
        this.requestQueryTransformer = params.requestQueryTransformer;
        this.responseSuccessTransformer = params.responseSuccessTransformer;
        this.responseErrorTransformer = params.responseErrorTransformer;
        this.removeAdditionalRequestProps = params.removeAdditionalRequestProps || false;
        this.removeAdditionalResponseProps = params.removeAdditionalResponseProps || false;
        this.roleAuthorizerKey = params.roleAuthorizerKey || null;
        this.filterByRole = params.filterByRole || false;
        this.defaultRoleName = params.defaultRoleName || 'default';
        this.AJVoptions = params.AJVoptions || {};
        this.config = {};
        this.lambdaBody = lambdaBody;
    }

    install () {
        return async (event, context, callback) => {
            try {
                if (isJson(event.body)) {
                    event.body = JSON.parse(event.body);
                }
                this.event = event;
    
                const { paths } = this.apiSpec;
                const {
                    body,
                    httpMethod,
                    path,
                    pathParameters,
                    queryStringParameters,
                } = this.event;
                const httpMethodLower = httpMethod.toLowerCase();

                if (this.validateRequests || this.validateResponses) {
                    if (paths[path] && paths[path][httpMethodLower]) {
                        this.config = paths[path][httpMethodLower];
                    }
                    else {
                        const pathKeys = Object.keys(paths);
                        // Converts accounts/{uuid} to accounts/[a-zA-z0-9-] to find key
                        const foundKey = find(pathKeys, key => {
                            const regex = RegExp(key.replace(/{[^}]*}/g, '([a-zA-z0-9-\\s\\+]|%20)+') + '$');
                            return regex.test(path) && paths[key][httpMethodLower];
                        });
                        if (foundKey) {
                            this.config = paths[foundKey][httpMethodLower];
                        }
                        else {
                            throw new ValidationError(`The path ${path} could not be found with http method ${httpMethodLower} in the API spec`, 400);
                        }
                    }
                    
                }
                
                // Validate Requests
                if (this.validateRequests) {
                    const filteredRequest = this._validateRequests(path, this.event, this.config, this.AJVoptions);
                    
                    // Replace the properties of the event with the filtered ones (body, queryParams, pathParams)
                    Object.assign(this.event, filteredRequest);
                }
                // Transform Requests
                if (this.requestBodyTransformer) {
                    const transformedBody = this.requestBodyTransformer(body || {});
                    this.event.body = transformedBody;
                }
                if (this.requestPathTransformer) {
                    const transformedPath = this.requestPathTransformer(pathParameters || {});
                    this.event.pathParameters = transformedPath;
                }
                if (this.requestQueryTransformer) {
                    const transformedQuery = this.requestQueryTransformer(queryStringParameters || {});
                    this.event.queryStringParameters = transformedQuery;
                }
    
                const lambdaResponse = await this.lambdaBody(event, context, callback);
                // Response from lambda should return an array containing the response and statusCode
                // It is expected that the lambda handles errors accordingly to return the correct status code and response
                let [ response, statusCode, message='' ] = lambdaResponse;
    
                // Informational and Success responses use the success transformer
                if (statusCode < 300) {
                    if (this.responseSuccessTransformer) {
                        response = this.responseSuccessTransformer(response, statusCode);
                    } else {
                        response = this._constructDefaultResponse(response, statusCode);
                    }
                } else if (this.responseErrorTransformer) {
                    response = this.responseErrorTransformer(response, statusCode, message);
                } else {
                    throw new ValidationError(message, statusCode);
                }

                // All responses require a body and statusCode where the body contains the response data
                if (!response.hasOwnProperty('body') || !response.hasOwnProperty('statusCode')) {
                    throw ValidationError('Response must contain a body and statusCode');
                }
    
                const responseBody = response.body;

                // Convert body to json if it's a string in json format in order to validate, else use the default value
                let responseToValidate = responseBody;
                let converted = false;

                if (isJson(responseBody)) {
                    responseToValidate = JSON.parse(responseBody);
                    converted = true;
                }

                if (this.validateResponses || this.filterByRole) {
                    let filteredResponse = null;
                    if (this.filterByRole && this.roleAuthorizerKey){
                        // Get role for requestContenxt > authorizer > roleKey
                        // if it doesn't exist for the user, use the default role
                        const role = get(event, `requestContext.authorizer.claims.${this.roleAuthorizerKey}`, event.requestContext.authorizer.claims[this.defaultRoleName]);
                        filteredResponse = this._validateResponses(path, responseToValidate, this.config, statusCode, this.AJVoptions, role);
                    } else {
                        filteredResponse = this._validateResponses(path, responseToValidate, this.config, statusCode, this.AJVoptions);
                    }
                    // Replace the content of the response by filtering based on the documentation
                    Object.assign(response, { body: converted ? JSON.stringify(filteredResponse) : filteredResponse });
                }
                // Allow for AWS v1 or v2 return form
                if (callback) {
                    callback(null, response);
                } else {
                    return response;
                }
            } catch (error) {
                // Allow for AWS v1 or v2 return form
                let response = {
                    body: JSON.stringify({ message: error.message }),
                    statusCode: error.statusCode || 500
                };
                if (callback) {
                    callback(null, response);
                } else {
                    return response;
                }
            }

        }
    }

    _validateRequests (path, event, schema, AJVoptions) {
        if (schema) {
            AJVoptions.removeAdditional = this.removeAdditionalRequestProps;
            const requestValidator = new RequestValidator(this.apiSpec, AJVoptions, schema);
            const request = {
                body: event.body || {},
                query: event.queryStringParameters || {},
                headers: event.headers || {},
                params: event.pathParameters || {},
            };
            // RFC requires header parameters to have case insensitive names. In order to support this
            // AJV converts all header property names to lower case and compares with lower case. So
            // convert the request proprty names to lowercase in order to accomodate.
            Object.keys(event.headers || {}).forEach(function(key){
                request.headers[key.toLowerCase()] = event.headers[key];
            });
            requestValidator.validate(path, request);

            // @NOTE: ajv validator replaces the request with the sanitized data
            // Replace the request properties with the values after validation to ensure that the values are filtered
            // At the same time return to original case for header parameters.
            let filtered = {
                body: request.body,
                queryStringParams: request.query,
                headers: request.headers,
                pathParameters: request.params,
            };
            Object.keys(event.headers || {}).forEach(function(key){
                if (request.headers[key.toLowerCase()]) filtered.headers[key] = request.headers[key.toLowerCase()];
            });

            return filtered;
        }
    }

    _validateResponses (path, response, schema, statusCode, AJVoptions, role = null) {
        if (schema) {
            AJVoptions.removeAdditional = this.removeAdditionalResponseProps;
            const responseValidator = new ResponseValidator(this.apiSpec, AJVoptions, schema, role);
            responseValidator.validate(path, response, statusCode);

        }
        // @NOTE: ajv validator replaces the response with the sanitized data
        return response;
    }

    _constructDefaultResponse (response, statusCode) {
        const body = isJson(response) ? JSON.stringify(response) : response;
        return {
            body,
            statusCode,
        };
    }
}