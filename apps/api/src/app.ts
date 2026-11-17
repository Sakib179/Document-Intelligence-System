import { buildHealthApp, checkObjectStorage, createObjectStorage } from '@doc/core';
import { checkDatabase, createDatabasePool } from '@doc/database';
import type { RuntimeEnvironment,EmbeddingClient } from '@doc/core';
import { registerIngestionRoutes } from './ingestion/routes.js';
import { ServiceError } from '@doc/core';
import { ZodError } from 'zod';
import { openApiDocument } from './workflow/openapi.js';

export function buildApi(environment: RuntimeEnvironment,options:{embeddingClient?:EmbeddingClient}={}) {
  const database = createDatabasePool(environment);
  const storage = createObjectStorage(environment);
  const uploadStorage = createObjectStorage(environment, environment.S3_OPERATION_TIMEOUT_MS);
  const app = buildHealthApp({
    service: 'api',
    logLevel: environment.LOG_LEVEL,
    requestTimeout: 120_000,
    defaultErrorHandler: false,
    checks: {
      postgres: () => checkDatabase(database),
      inspector: async () => {
        const response = await fetch('http://' + environment.PROCESSOR_HOST + ':' + environment.PROCESSOR_PORT + '/health/ready', { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) throw new Error('File inspector unavailable');
        await response.body?.cancel();
      },
      objectStorage: () => checkObjectStorage(storage, environment.S3_BUCKET),
    },
  });
  app.addHook('onRoute',function(route){
    if(route.url.startsWith('/v1/')&&route.method!=='HEAD'){
      if(route.url!=='/v1/documents/:id/status')this.route({...route,url:'/api'+route.url});
      if(route.url==='/v1/upload-batches'&&route.method==='POST')this.route({...route,url:'/api/v1/documents'});
    }
  });
  app.addHook('onSend',async(request,reply,payload)=>{
    const location=reply.getHeader('location');
    if(request.url.startsWith('/api/')&&typeof location==='string'&&location.startsWith('/v1/'))reply.header('Location','/api'+location);
    if(request.url.startsWith('/api/v1/'))reply.header('Cache-Control','no-store');
    return payload;
  });
  app.get('/api/openapi.json',()=>openApiDocument);
  app.register(async (scope) => registerIngestionRoutes(scope, { environment, pool: database, storage: uploadStorage,...options }));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      if (error.statusCode === 413) reply.header('Connection', 'close');
      if (['UPLOAD_IN_PROGRESS', 'UPLOAD_CAPACITY_REACHED'].includes(error.code)) reply.header('Retry-After', '2');
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if(['FST_ERR_CTP_INVALID_JSON_BODY','FST_ERR_CTP_EMPTY_JSON_BODY'].includes(code))return reply.code(400).send({error:{code:'INVALID_JSON',message:'Supply a valid JSON body.'}});
    if(code==='FST_ERR_CTP_BODY_TOO_LARGE')return reply.code(413).send({error:{code:'REQUEST_TOO_LARGE',message:'The request body exceeds its limit.'}});
    if(['FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(code))return reply.code(415).send({error:{code:'UNSUPPORTED_MEDIA_TYPE',message:'Unsupported content type.'}});
    if (['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT'].includes(code)) {
      return reply.header('Connection', 'close').code(413).send({ error: { code: 'UPLOAD_LIMIT_EXCEEDED', message: 'The upload exceeds configured file or part limits.' } });
    }
    if (error instanceof ZodError || code === 'FST_FIELDS_LIMIT' || (typeof error === 'object' && error !== null && 'validation' in error)) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'The request does not match the API contract.' } });
    }
    app.log.error({ errorCode: code || 'UNKNOWN' }, 'API request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  });
  app.addHook('onClose', async () => {
    storage.destroy();
    uploadStorage.destroy();
    await database.end();
  });
  return app;
}
