/* tslint:disable:no-console */
import { promises } from 'fs';
import { DocumentNode, parse } from 'graphql';
import { GraphQLClient } from 'graphql-request';
import { default as fetch } from 'node-fetch';

// tslint:disable-next-line:no-var-requires
// @ts-ignore
// tslint:disable-next-line:no-var-requires
global.fetch = require('fetch-cookie/node-fetch')(require('node-fetch'));

function requestLogger(httpModule){
    const original = httpModule.request;
    httpModule.request = (options, callback) => {
        console.log(options.href || options.proto + '://' + options.host + options.path, options.method);
        console.log(options);
        return original(options, callback);
    };
}

// tslint:disable-next-line:no-var-requires
requestLogger(require('http'));
// tslint:disable-next-line:no-var-requires
requestLogger(require('https'));

const GQL_CACHE: { [id: string]: string} = {};
async function loadGql(name: string) {
    if (!(name in GQL_CACHE)) {
        const contents = await promises.readFile('gql/' + name + '.graphql', 'utf-8');
        GQL_CACHE[name] = contents; // parse(contents);
    }
    return GQL_CACHE[name];
}

async function uploadAssets(client: GraphQLClient, product: any) {
    const assetIds: {[url: string]: string } = {};
    const assetFile = fetch(product.result.sync_product.thumbnail_url);
    const file = {
        createReadStream: () => {
            console.log('in cRS');
        },
    };
    const mutUpdate = await client.request(await loadGql('create_assets'), {
        input: [{file}],
    });
    console.log(mutUpdate);
}

async function main() {
    const graphQLClient = new GraphQLClient('http://localhost:3000/admin-api', {
        credentials: 'same-origin',
    });
    console.log(1);
    const mutLogin = await graphQLClient.request(await loadGql('attempt_login'), {
        username: 'superadmin',
        password: 'superadmin',
        rememberMe: true,
    });
    console.log(mutLogin);
    console.log(2);

    const productId = '189841751';
    const apiKey = 'qyw4y7as-qvdq-2s7m:1150-1yguayztyrwz';
    const product = await ((await fetch('https://api.printful.com/store/products/' + productId, {
        headers: {Authorization: 'Basic ' + Buffer.from(apiKey).toString('base64')},
    })).json());
    console.log('product', product);
    await uploadAssets(graphQLClient, product);
}

main();
