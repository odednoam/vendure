import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { ID } from '@vendure/common/lib/shared-types';
import crypto from 'crypto';
import { decode as jwtDecode, verify as jwtVerify } from 'jsonwebtoken';
import ms from 'ms';
import { Connection } from 'typeorm';

import { RequestContext } from '../../api';
import { NotVerifiedError, UnauthorizedError } from '../../common';
import { ConfigService } from '../../config';
import { Order } from '../../entity';
import { AnonymousSession } from '../../entity';
import { AuthenticatedSession } from '../../entity';
import { Session } from '../../entity';
import { User } from '../../entity';
import { EventBus } from '../../event-bus';
import { AttemptedLoginEvent } from '../../event-bus';
import { LoginEvent } from '../../event-bus';
import { LogoutEvent } from '../../event-bus/events/logout-event';
import { PasswordCiper } from '../helpers/password-cipher/password-ciper';

import { OrderService } from './order.service';

/**
 * The AuthService manages both authenticated and anonymous Sessions.
 */
@Injectable()
export class AuthService {
    private readonly sessionDurationInMs: number;

    constructor(
        @InjectConnection() private connection: Connection,
        private passwordCipher: PasswordCiper,
        private configService: ConfigService,
        private orderService: OrderService,
        private eventBus: EventBus,
    ) {
        this.sessionDurationInMs = ms(this.configService.authOptions.sessionDuration as string);
    }

    /**
     * Authenticates a user's credentials and if okay, creates a new session.
     */
    async authenticate(
        ctx: RequestContext,
        identifier: string,
        password: string,
    ): Promise<AuthenticatedSession> {
        this.eventBus.publish(new AttemptedLoginEvent(ctx, identifier));
        const user = await this.getUserFromIdentifier(identifier);
        if (
            !(
                (await this.verifyJwt(identifier, password)) ||
                (await this.verifyUserPassword(user.id, password))
            )
        ) {
            throw new UnauthorizedError();
        }
        if (this.configService.authOptions.requireVerification && !user.verified) {
            throw new NotVerifiedError();
        }

        if (ctx.session && ctx.session.activeOrder) {
            await this.deleteSessionsByActiveOrder(ctx.session && ctx.session.activeOrder);
        }
        const session = await this.createNewAuthenticatedSession(ctx, user);
        const newSession = await this.connection.getRepository(AuthenticatedSession).save(session);
        this.eventBus.publish(new LoginEvent(ctx, user));
        return newSession;
    }

    /**
     * Verify the provided password against the one we have for the given user, or as a JWT token.
     */
    async verifyUserPassword(userId: ID, password: string): Promise<boolean> {
        const user = await this.connection.getRepository(User).findOne(userId, { select: ['passwordHash'] });
        if (!user) {
            throw new UnauthorizedError();
        }
        const passwordMatches = await this.passwordCipher.check(password, user.passwordHash);
        if (!passwordMatches) {
            throw new UnauthorizedError();
        }
        return true;
    }

    async verifyJwt(identifier: string, jwt: string): Promise<boolean> {
        try {
            // @ts-ignore
            const parsedToken = jwtDecode(jwt);
            if (parsedToken === null) {
                return false;
            }
            // @ts-ignore
            const iss = parsedToken.iss;
            if (iss === undefined) {
                return false;
            }
            const signatureDomainKey = this.configService.authOptions.trustedAuthDomains[iss];
            if (signatureDomainKey === undefined) {
                return false;
            }
            const userToken = await jwtVerify(jwt, signatureDomainKey);
            // @ts-ignore
            // @ts-ignore
            return userToken?.email === identifier;
        } catch {
            return false;
        }
    }

    /**
     * Create an anonymous session.
     */
    async createAnonymousSession(): Promise<AnonymousSession> {
        const token = await this.generateSessionToken();
        const anonymousSessionDurationInMs = ms('1y');
        const session = new AnonymousSession({
            token,
            expires: AuthService.getExpiryDate(anonymousSessionDurationInMs),
            invalidated: false,
        });
        // save the new session
        return await this.connection.getRepository(AnonymousSession).save(session);
    }

    /**
     * Looks for a valid session with the given token and returns one if found.
     */
    async validateSession(token: string): Promise<Session | undefined> {
        const session = await this.connection
            .getRepository(Session)
            .createQueryBuilder('session')
            .leftJoinAndSelect('session.activeOrder', 'activeOrder')
            .leftJoinAndSelect('session.user', 'user')
            .leftJoinAndSelect('user.roles', 'roles')
            .leftJoinAndSelect('roles.channels', 'channels')
            .where('session.token = :token', { token })
            .andWhere('session.invalidated = false')
            .getOne();

        if (session && session.expires > new Date()) {
            await this.updateSessionExpiry(session);
            return session;
        }
    }

    async setActiveOrder<T extends Session>(session: T, order: Order): Promise<T> {
        session.activeOrder = order;
        return this.connection.getRepository(Session).save(session);
    }

    async unsetActiveOrder<T extends Session>(session: T): Promise<T> {
        if (session.activeOrder) {
            session.activeOrder = null;
            return this.connection.getRepository(Session).save(session);
        }
        return session;
    }

    /**
     * Deletes all existing sessions for the given user.
     */
    async deleteSessionsByUser(user: User): Promise<void> {
        await this.connection.getRepository(AuthenticatedSession).delete({ user });
    }

    /**
     * Deletes all existing sessions with the given activeOrder.
     */
    async deleteSessionsByActiveOrder(activeOrder: Order): Promise<void> {
        await this.connection.getRepository(Session).delete({ activeOrder });
    }

    /**
     * Deletes all sessions for the user associated with the given session token.
     */
    async deleteSessionByToken(ctx: RequestContext, token: string): Promise<void> {
        const session = await this.connection.getRepository(AuthenticatedSession).findOne({
            where: { token },
            relations: ['user'],
        });
        if (session) {
            this.eventBus.publish(new LogoutEvent(ctx));
            return this.deleteSessionsByUser(session.user);
        }
    }

    private async createNewAuthenticatedSession(
        ctx: RequestContext,
        user: User,
    ): Promise<AuthenticatedSession> {
        const token = await this.generateSessionToken();
        const guestOrder =
            ctx.session && ctx.session.activeOrder
                ? await this.orderService.findOne(ctx, ctx.session.activeOrder.id)
                : undefined;
        const existingOrder = await this.orderService.getActiveOrderForUser(ctx, user.id);
        const activeOrder = await this.orderService.mergeOrders(ctx, user, guestOrder, existingOrder);
        return new AuthenticatedSession({
            token,
            user,
            activeOrder,
            expires: AuthService.getExpiryDate(this.sessionDurationInMs),
            invalidated: false,
        });
    }

    private async getUserFromIdentifier(identifier: string): Promise<User> {
        const user = await this.connection.getRepository(User).findOne({
            where: { identifier },
            relations: ['roles', 'roles.channels'],
        });
        if (!user) {
            throw new UnauthorizedError();
        }
        return user;
    }

    /**
     * Generates a random session token.
     */
    private generateSessionToken(): Promise<string> {
        return new Promise((resolve, reject) => {
            crypto.randomBytes(32, (err, buf) => {
                if (err) {
                    reject(err);
                }
                resolve(buf.toString('hex'));
            });
        });
    }

    /**
     * If we are over half way to the current session's expiry date, then we update it.
     *
     * This ensures that the session will not expire when in active use, but prevents us from
     * needing to run an update query on *every* request.
     */
    private async updateSessionExpiry(session: Session) {
        const now = new Date().getTime();
        if (session.expires.getTime() - now < this.sessionDurationInMs / 2) {
            await this.connection
                .getRepository(Session)
                .update({ id: session.id }, { expires: AuthService.getExpiryDate(this.sessionDurationInMs) });
        }
    }

    /**
     * Returns a future expiry date according timeToExpireInMs in the future.
     */
    private static getExpiryDate(timeToExpireInMs: number): Date {
        return new Date(Date.now() + timeToExpireInMs);
    }
}
