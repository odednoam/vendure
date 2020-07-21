const {
    storeCreditPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSearchPlugin,
} = require('@vendure/core');
const { defaultEmailHandlers, EmailPlugin } = require('@vendure/email-plugin');
const { AssetServerPlugin } = require('@vendure/asset-server-plugin');
const { AdminUiPlugin } = require('@vendure/admin-ui-plugin');
const path = require('path');

console.log("!!!!", storeCreditPaymentHandler);
const config = {
    apiOptions: {
        port: 3000,
        adminApiPath: 'admin-api',
        adminApiPlayground: {
            settings: {
                'request.credentials': 'include',
            },
        },// turn this off for production
        adminApiDebug: true, // turn this off for production
        shopApiPath: 'shop-api',
        shopApiPlayground: {
            settings: {
                'request.credentials': 'include',
            },
        },// turn this off for production
        shopApiDebug: true,// turn this off for production
    },
    authOptions: {
        tokenMethod: 'cookie',
        sessionSecret: 'g4a7u57p8yi',
        superadminCredentials: {
            identifier: 'superadmin',
            password: 'superadmin',
        },
    },
    dbConnectionOptions: {
        type: 'sqlite',
        synchronize: false, // not working with SQLite/SQL.js, see https://github.com/typeorm/typeorm/issues/2576
        logging: false,
        database: path.join(__dirname, '../vendure.sqlite'),
        migrations: [path.join(__dirname, '../migrations/*.ts')],
    },
    paymentOptions: {
        paymentMethodHandlers: [storeCreditPaymentHandler],
    },
    customFields: {
        Customer: [
            {
                name: 'creditBalance',
                type: 'int',
                label: [{value: 'Credit balance', languageCode: 'en'}],
                description: [{value: '', languageCode: 'en'}],
                public: true,
                internal: false,
                readonly: false,
                defaultValue: 0,
                nullable: false,

            },
        ]
    },
    plugins: [
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, '../static/assets'),
            port: 3001,
        }),
        DefaultJobQueuePlugin,
        DefaultSearchPlugin,
        EmailPlugin.init({
            devMode: true,
            outputPath: path.join(__dirname, '../static/email/test-emails'),
            mailboxPort: 3003,
            handlers: defaultEmailHandlers,
            templatePath: path.join(__dirname, '../static/email/templates'),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implementation
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:8080/verify',
                passwordResetUrl: 'http://localhost:8080/password-reset',
                changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change'
            },
        }),
        AdminUiPlugin.init(
            {
                port: 3002,
                app: {
                    outputPath: path.join(__dirname, 'admin-ui'),
                    path: '/Users/odednoam/IdeaProjects/vendure/packages/admin-ui/dist',
                    devMode: true,
                }

            },
        ),
    ],
};

module.exports = { config };
