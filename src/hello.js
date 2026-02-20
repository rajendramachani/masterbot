module.exports = (app) => {
    app.get('/hello', (req, res) => {
        res.status(200).send('Hello World');
    });
};