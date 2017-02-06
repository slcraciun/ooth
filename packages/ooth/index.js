const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
const session = require('express-session')
const passport = require('passport')
const JwtStrategy = require('passport-jwt').Strategy
const ExtractJwt = require('passport-jwt').ExtractJwt
const {MongoClient, ObjectId} = require('mongodb')
const {sign} = require('jsonwebtoken')
const nodeify = require('nodeify')
const {randomBytes} = require('crypto')

function randomToken() {
    return randomBytes(43).toString('hex')
}

function requireLogged(req, res, next) {
    if (!req.user) {
        return res.status(400).send({
            status: 'error',
            message: 'Not logged in'
        })        
    }
    next()
}

function requireNotLogged(req, res, next) {
    if (req.user) {
        return res.status(400).send({
            status: 'error',
            message: 'User is already logged in'
        })
    }
    next()
}

function requireNotRegistered(req, res, next) {
    if (req.user) {
        return res.status(400).send({
            status: 'error',
            message: 'Current user is already registered'
        })
    }
    next()
}

function nodeifyAsync(asyncFunction) {
    return function(...args) {
        return nodeify(asyncFunction(...args.slice(0, -1)), args[args.length-1])
    }
}

class Ooth {
    constructor({
        mongoUrl,
        sharedSecret,
    }) {
        this.mongoUrl = mongoUrl
        this.sharedSecret = sharedSecret

        this.uniqueFields = {}
        this.strategies = {}

    }
    start(app) {
        return (async () => {
            this.app = app
            this.db = await MongoClient.connect(this.mongoUrl)
            this.Users = this.db.collection('users')

            app.use(cookieParser())
            app.use(bodyParser.json())
            app.use(bodyParser.urlencoded({
                extended: true
            }))
            app.use(session({
                secret: 'some secret',
                resave: false,
                saveUninitialized: true,
            }))
            app.use(passport.initialize())
            app.use(passport.session())
            passport.serializeUser((user, done) => {
                console.log("serialize", user)
                done(null, user._id)
            })
            passport.deserializeUser((id, done) => {
                console.log("deserializing", id)
                if (typeof id === 'string') {
                    this.Users.findOne(ObjectId(id), done)
                } else {
                    done(null, false)
                }
            })
            
            app.all('/', requireLogged, this.returnToken.bind(this))
            this.registerPassportMethod(null, 'login', requireNotLogged, new JwtStrategy({
                secretOrKey: this.sharedSecret,
                jwtFromRequest: (req) => {
                    if (!req.body || !req.body.token) {
                        throw new Error('Malformed body')
                    }
                    return req.body.token
                }
            }, nodeifyAsync(async (...args) => {
                console.log("this is not working")
                console.log("tokencontent", args)
            })))
            app.post('/logout', requireLogged, (req, res) => {
                req.logout()
                res.send({
                    message: 'Logged out'
                })
            })


        })()
    }
    returnToken(req, res) {
        const user = req.user
        console.log("request", user)
        res.send({
            token: sign({ user }, this.sharedSecret)
        })
    }
    use(name, strategy) {
        strategy({
            name,
            registerPassportMethod: (...args) => {
                this.registerPassportMethod(name, ...args)
            },
            registerMethod: (method, ...handlers) => {
                this.app.post(`/${strategy}/${method}`, ...handlers)
            },
            registerUniqueField: (id, fieldName) => {
                if (!this.uniqueFields[id]) {
                    this.uniqueFields[id] = []
                }
                this.uniqueFields[id].push(`${name}.${fieldName}`)
            },
            getUserByUniqueField: async (fieldName, value) => {
                return await this.Users.findOne({
                    $or: this.uniqueFields[fieldName].map(field => ({
                        [field]: value
                    }))
                })
            },
            getUserByField: async (fields) => {
                const actualFields = {}
                Object.keys(fields).forEach(field => {
                    actualFields[`${name}.${field}`] = fields[field]
                })
                return await this.Users.findOne(actualFields)
            },
            updateUser: async (_id, fields) => {
                const actualFields = {}
                Object.keys(fields).forEach(field => {
                    actualFields[`${name}.${field}`] = fields[field]
                })
                return await this.Users.update({
                    _id
                }, {
                    $set: actualFields
                })
            },
            insertUser: async (_id, fields) => {
                const query = {}
                if (fields) {
                    Object.keys(fields).forEach(field => {
                        query[`${name}.${field}`] = fields[field]
                    })
                }
                const {insertedId} = await this.Users.insertOne(query)
                return insertedId
            },
            requireLogged,
            requireNotLogged,
            requireNotRegistered
        })
    }
    registerPassportMethod(strategy, method, ...handlers) {
        const middleware = handlers.slice(0, -1)
        const handler = handlers[handlers.length-1]
        const methodName = strategy ? `${strategy}-${method}` : method
        const routeName = strategy ? `/${strategy}/${method}` : `/${method}`
        passport.use(methodName, handler)
        this.app.post(routeName, ...middleware, (req, res, next) => {
            passport.authenticate(methodName, (err, user, info) => {
                if (err) {
                    return next(err)
                }
                if (!user) {
                    return res.send(info)
                }
                req.login(user, loginErr => {
                    if (loginErr) {
                        return next(loginErr)
                    }
                    this.returnToken(req, res)
                })
            })(req, res, next)
        })
    }
}

module.exports = Ooth